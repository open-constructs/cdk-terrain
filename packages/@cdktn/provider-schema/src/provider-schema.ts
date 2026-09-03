// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as path from "path";

import { convertFiles } from "@cdktn/hcl2json";
import {
  Attribute,
  AttributeType,
  Block,
  ConstructsMakerModuleTarget,
  ConstructsMakerProviderTarget,
  Input,
  ModuleIndex,
  ModuleSchema,
  ProviderSchema,
  TerraformCliVersion,
  TerraformModuleConstraint,
  TerraformTargetVersions,
  VersionSchema,
  exec,
  isNestedTypeAttribute,
  logger,
  parseTerraformCliVersion,
  withTempDir,
} from "@cdktn/commons";
import {
  SCHEMA_EMISSION_FAMILY_LABELS,
  checkSchemaEmissionGapFamilies,
  suggestedEmittingCliVersions,
} from "./emission-check";

const terraformBinaryName = process.env.TERRAFORM_BINARY_NAME || "terraform";

let fetchingCliVersionPromise: Promise<TerraformCliVersion> | undefined;

/**
 * Determines the version of the fetching CLI (`terraform`/`tofu` binary
 * resolved via `TERRAFORM_BINARY_NAME`) once per process, memoized.
 *
 * Used both to stamp fetched provider schemas (`cli_name`/`cli_version`)
 * and as the cache key suffix in read.ts, since schema emission is fixed
 * per CLI minor version.
 *
 * @internal exposed for testing like terraformInitWithRetry
 */
export function getFetchingCliVersion(): Promise<TerraformCliVersion> {
  if (!fetchingCliVersionPromise) {
    fetchingCliVersionPromise = exec(terraformBinaryName, ["version"], {
      cwd: process.cwd(),
    }).then(parseTerraformCliVersion);
  }
  return fetchingCliVersionPromise;
}

// Provider binaries are downloaded from GitHub release CDNs during
// `terraform init`, which intermittently returns 5xx. Retry on those
// signatures only — real config/schema errors should still fail fast.
const TRANSIENT_INIT_ERROR_PATTERNS = [
  /\b50[234]\b/,
  /Bad Gateway/i,
  /Service Unavailable/i,
  /Gateway Timeout/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /unexpected EOF/i,
];

/**
 * Runs `terraform init` and retries on transient HTTP/network failures.
 *
 * Provider binaries are pulled from GitHub's release CDN, which
 * intermittently returns 5xx. The retry only fires when stderr matches a
 * known transient pattern — real errors (bad version, schema parse, etc.)
 * still fail on the first attempt.
 *
 * @param options - spawn options forwarded to `exec` (`cwd` is required so
 *   `terraform init` runs inside the temp dir holding `main.tf.json`)
 * @param maxAttempts - total attempts including the initial call; the number
 *   of retries is `maxAttempts - 1`. Defaults to 5 (1 initial + 4 retries)
 * @param baseDelayMs - delay before the first retry. Tests pass `0` to skip
 *   waits. Defaults to 5000ms
 * @param backoffMultiplier - factor applied to the delay on each subsequent
 *   retry (so retries wait `baseDelayMs * multiplier^(attempt-1)`). Defaults
 *   to 2 (1s → 2s → 4s …)
 * @returns stdout from the successful `terraform init` invocation
 * @internal exposed for testing
 */
export async function terraformInitWithRetry(
  options: { cwd: string },
  maxAttempts = 5,
  baseDelayMs = 5000,
  backoffMultiplier = 2,
): Promise<string> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await exec(terraformBinaryName, ["init"], options);
    } catch (error: any) {
      const stderr: string = error?.stderr ?? "";
      const transient = TRANSIENT_INIT_ERROR_PATTERNS.some((p) =>
        p.test(stderr),
      );
      if (!transient || attempt === maxAttempts) {
        throw error;
      }
      const delayMs = baseDelayMs * backoffMultiplier ** (attempt - 1);
      console.log(
        `terraform init failed with a transient error, retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts - 1})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("unreachable");
}

/**
 * Fully Qualified provider name in the format:
 * like e.g. registry.terraform.io/hashicorp/aws
 */
export type FQPN = string & { __type: "FullyQualifiedProviderName" };
export type ProviderHostname = string & { __type: "ProviderHostname" };
export type ProviderNamespace = string & { __type: "ProviderNamespace" };
export type ProviderName = string & { __type: "ProviderName" };

export const parseFQPN = (f: FQPN) => {
  const [hostname, namespace, name] = f.split("/");
  if (!name) {
    throw new Error(`can't handle ${f}`);
  }
  return { hostname, namespace, name } as {
    hostname: ProviderHostname;
    namespace: ProviderNamespace;
    name: ProviderName;
  };
};

const unwrapIfArray = <T>(item: T | T[]): T =>
  Array.isArray(item) ? item[0] : item;

const transformVariables = (variables: any) => {
  const result: Input[] = [];

  if (!variables) return result;

  for (const name of Object.keys(variables)) {
    const variable = unwrapIfArray(variables[name]);
    let variableType: string;

    if (
      // eslint-disable-next-line no-prototype-builtins
      variable.hasOwnProperty("type") == false &&
      // eslint-disable-next-line no-prototype-builtins
      variable.hasOwnProperty("default") == true
    ) {
      switch (typeof variable["default"]) {
        case "boolean":
          variableType = "bool";
          break;
        case "number":
          variableType = "number";
          break;
        default:
          variableType = "any";
      }
    } else {
      const rawVariableType = variable["type"];
      if (
        typeof rawVariableType === "string" &&
        rawVariableType.startsWith("${") &&
        rawVariableType.endsWith("}") &&
        !rawVariableType.includes("\n")
      ) {
        variableType = rawVariableType.slice(2, -1);
      } else {
        variableType = "any";
      }
    }

    const item: Input = {
      name,
      type: variableType,
      description: variable["description"],
      // eslint-disable-next-line no-prototype-builtins
      required: variable.hasOwnProperty("default") == false,
    };

    if (!item.required) {
      item["default"] = variable["default"];
    }

    result.push(item);
  }

  return result;
};

const transformOutputs = (outputs: any) => {
  const result = [];

  if (outputs) {
    for (const name of Object.keys(outputs)) {
      const output = unwrapIfArray(outputs[name]);

      const item: any = {
        name,
        description: output["description"],
      };

      result.push(item);
    }
  }

  return result;
};

const harvestModuleSchema = async (
  workingDirectory: string,
  modules: string[],
): Promise<Record<string, any>> => {
  const fileName = path.join(
    workingDirectory,
    ".terraform",
    "modules",
    "modules.json",
  );
  const result: Record<string, any> = {};

  if (!fs.existsSync(fileName)) {
    throw new Error(
      `Modules were not generated properly - couldn't find ${fileName}`,
    );
  }

  const moduleIndex = JSON.parse(
    fs.readFileSync(fileName, "utf-8"),
  ) as ModuleIndex;

  for (const mod of modules) {
    const m = moduleIndex.Modules.find((other) => mod === other.Key);

    if (!m) {
      throw new Error(`Couldn't find ${m}`);
    }

    const parsed = await convertFiles(path.join(workingDirectory, m.Dir));

    if (!parsed) {
      throw new Error(
        `Modules were not generated properly - couldn't parse ${m.Dir}`,
      );
    }

    const schema: ModuleSchema = {
      inputs: transformVariables(parsed.variable),
      outputs: transformOutputs(parsed.output),
      name: mod,
    };

    result[mod] = schema;
  }

  return result;
};

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface TerraformConfig {
  // a list holds several configurations of the same provider, which is how
  // aliased provider blocks are expressed in JSON syntax
  provider?: { [name: string]: Record<string, any> | Record<string, any>[] };
  terraform: {
    required_providers?: {
      [name: string]: { source?: string; version?: string };
    };
  };
  module?: {
    [name: string]: {
      source: string;
      version?: string;
      providers?: { [localName: string]: string };
    };
  };
}

export async function readProviderSchema(
  target: ConstructsMakerProviderTarget,
) {
  const config: TerraformConfig = {
    provider: {},
    terraform: {
      required_providers: {},
    },
  };

  config.provider![target.name] = {};
  config.terraform.required_providers![target.name] = {
    version: target.version,
    source: target.source,
  };

  let providerSchema: ProviderSchema = { format_version: "0.1" };

  await withTempDir("fetchProviderSchema", async () => {
    const outdir = process.cwd();
    const filePath = path.join(outdir, "main.tf.json");
    await fs.writeFile(filePath, JSON.stringify(config));

    await terraformInitWithRetry({ cwd: outdir });
    providerSchema = JSON.parse(
      await exec(terraformBinaryName, ["providers", "schema", "-json"], {
        cwd: outdir,
      }),
    ) as ProviderSchema;

    const versionSchema = JSON.parse(
      await exec(terraformBinaryName, ["version", "-json"], {
        cwd: outdir,
      }),
    ) as VersionSchema;

    providerSchema.provider_versions = versionSchema.provider_selections;
  });

  // Stamp the fetching CLI's identity so downstream consumers can reason
  // about which newer-protocol sections this fetch could possibly have
  // emitted. Never fail the fetch over this - it's best-effort metadata.
  try {
    const cli = await getFetchingCliVersion();
    providerSchema.cli_name = cli.name;
    providerSchema.cli_version = cli.version;
  } catch (error) {
    logger.debug(
      `Could not determine fetching CLI version to stamp provider schema: ${error}`,
    );
  }

  return sanitizeProviderSchema(providerSchema);
}

/**
 * Warns when the CLI that produced a given provider schema predates one or
 * more schema-emission boundaries the project's declared `targetVersions`
 * care about (see emission-check.ts) - i.e. some newer-protocol sections
 * (functions, ephemeral resources, ...) may be missing from the generated
 * bindings even though the schema fetch itself succeeded.
 *
 * Deliberately decoupled from the fetch path (readProviderSchema) so it
 * also runs for schemas served from the on-disk cache: cached JSON carries
 * the same `cli_name`/`cli_version` stamps a fresh fetch would have
 * written (the cache key already segments by CLI product+minor), so the gap
 * check is just as meaningful on a cache hit as on a miss.
 *
 * No-op without `targetVersions` - there is nothing to compare the CLI
 * against. Falls back to the current process's fetching CLI version when
 * the schema itself isn't stamped (e.g. older cache entries written before
 * stamping existed).
 *
 * @internal exposed for testing
 */
export async function warnIfSchemaEmissionGaps(
  schema: ProviderSchema,
  targetVersions?: TerraformTargetVersions,
): Promise<void> {
  if (!targetVersions) return;

  let cli: TerraformCliVersion;
  if (schema.cli_name && schema.cli_version) {
    if (schema.cli_name !== "terraform" && schema.cli_name !== "opentofu") {
      return;
    }
    cli = { name: schema.cli_name, version: schema.cli_version };
  } else {
    try {
      cli = await getFetchingCliVersion();
    } catch (error) {
      logger.debug(
        `Could not determine fetching CLI version to check for schema emission gaps: ${error}`,
      );
      return;
    }
  }

  const gapFamilies = checkSchemaEmissionGapFamilies(cli, targetVersions);
  if (gapFamilies.length > 0 && cli.version) {
    logger.warn(
      `provider schema fetched with ${cli.name} ${cli.version} — ${joinWithAnd(
        gapFamilies.map((family) => SCHEMA_EMISSION_FAMILY_LABELS[family]),
      )} will not be generated; run cdktn get with ${suggestedEmittingCliVersions(
        gapFamilies,
      )}`,
    );
  }
}

// The providers have some potential bugs that we want to pro-actively
// fix here so that the rest of the code can assume a consistent schema.
export function sanitizeProviderSchema(schema: ProviderSchema): ProviderSchema {
  // Mainly some attributes are "doubled", e.g. ["list", "string", "list", "string"]
  // instead of ["list", "string"]
  function attributeDoublingFix(attribute: Attribute): Attribute {
    if (isNestedTypeAttribute(attribute) || !Array.isArray(attribute.type)) {
      return attribute;
    }

    const type =
      attribute.type.length === 2
        ? attribute.type
        : (attribute.type as string[]).slice(0, 2); // The types tell us this can't happen, reality begs to differ

    attribute.type = type as AttributeType;
    return attribute;
  }

  // Mutates block with the fix
  function sanitizeBlock(block: Block) {
    Object.values(block.attributes || {}).forEach(attributeDoublingFix);
    Object.values(block.block_types || {}).forEach((blockType) => {
      sanitizeBlock(blockType.block);
    });
  }

  Object.values(schema.provider_schemas || {}).forEach((provider) => {
    const entities = [
      provider.provider,
      ...Object.values(provider.resource_schemas || {}),
      ...Object.values(provider.data_source_schemas || {}),
      ...Object.values(provider.ephemeral_resource_schemas || {}),
    ];

    entities.forEach((entity) => {
      sanitizeBlock(entity.block);
    });
  });

  return schema;
}

/**
 * A provider configuration that a module expects to be handed by its caller,
 * declared as `configuration_aliases` in the module's `required_providers`.
 */
export interface ModuleProviderAlias {
  /** local name the module knows the provider by, e.g. `aws` */
  localName: string;
  /** alias part of the reference, e.g. `global_region` */
  alias: string;
  /** provider source the module declared for `localName`, if it declared one */
  source?: string;
}

const CONFIGURATION_ALIAS = /^([\w-]+)\.([\w-]+)$/;

// hcl2json hands HCL expressions back as interpolations, so a
// `configuration_aliases = [aws.global_region]` entry arrives as the string
// "${aws.global_region}". A .tf.json module writes the same reference as a
// plain string, which hcl2json passes through untouched.
const unwrapInterpolation = (value: string) =>
  value.startsWith("${") && value.endsWith("}") ? value.slice(2, -1) : value;

const toArray = <T>(item: T | T[] | undefined | null): T[] => {
  if (item === undefined || item === null) return [];
  return Array.isArray(item) ? item : [item];
};

/**
 * Collects the provider configurations a module requires its caller to pass
 * in, from the hcl2json representation of the module's directory.
 *
 * hcl2json represents every HCL block as an array (one entry per occurrence
 * across the module's files), so a module may declare `required_providers` in
 * more than one `terraform` block; all of them are considered. Blocks read
 * from a .tf.json module arrive unwrapped instead, and both shapes are
 * handled here.
 *
 * @internal exposed for testing
 */
export function collectModuleProviderAliases(
  parsedModule: any,
): ModuleProviderAlias[] {
  const aliases: ModuleProviderAlias[] = [];
  const seen = new Set<string>();

  for (const terraformBlock of toArray(parsedModule?.terraform)) {
    for (const requiredProviders of toArray(
      terraformBlock?.required_providers,
    )) {
      for (const declaration of Object.values(requiredProviders || {})) {
        const provider = unwrapIfArray(declaration as any);

        for (const entry of toArray(provider?.configuration_aliases)) {
          const match = CONFIGURATION_ALIAS.exec(
            unwrapInterpolation(String(entry)),
          );
          if (!match) continue;

          const [, localName, alias] = match;
          const key = `${localName}.${alias}`;
          if (seen.has(key)) continue;
          seen.add(key);

          aliases.push({ localName, alias, source: provider?.source });
        }
      }
    }
  }

  return aliases;
}

/**
 * Declares the provider configurations that `aliases` names on the synthetic
 * root config and passes them into the module call, which is what Terraform
 * demands of anyone calling a module with `configuration_aliases`.
 *
 * The alias blocks stay empty: `terraform get` only builds the configuration
 * tree, it never configures or installs a provider. Sources are mirrored from
 * the module's own `required_providers` so a module referring to, say,
 * hashicorp/aws under a non-default local name still resolves to the same
 * provider in the root.
 *
 * @internal exposed for testing
 */
export function applyModuleProviderAliases(
  config: TerraformConfig,
  moduleKey: string,
  aliases: ModuleProviderAlias[],
): TerraformConfig {
  const moduleCall = config.module?.[moduleKey];
  if (!moduleCall || aliases.length === 0) return config;

  for (const { localName, alias, source } of aliases) {
    if (source) {
      config.terraform.required_providers = {
        ...config.terraform.required_providers,
        [localName]: { source },
      };
    }

    config.provider = config.provider || {};
    const blocks = toArray(config.provider[localName]);
    if (!blocks.some((block) => block.alias === alias)) {
      blocks.push({ alias });
    }
    config.provider[localName] = blocks;

    moduleCall.providers = {
      ...moduleCall.providers,
      [`${localName}.${alias}`]: `${localName}.${alias}`,
    };
  }

  return config;
}

/**
 * The `//subdir` portion of a module source, if it has one, mirroring how
 * Terraform unpacks a package into `.terraform/modules/<key>/<subdir>`.
 *
 * @internal exposed for testing
 */
export function packageSubdir(source: string): string | undefined {
  const [withoutQuery] = source.split("?");
  const withoutGetterPrefix = withoutQuery.replace(/^[A-Za-z0-9]+::/, "");
  const withoutScheme = withoutGetterPrefix.replace(
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\/+/,
    "",
  );

  const [, ...rest] = withoutScheme.split("//");
  const subdir = rest.join("//").replace(/^\/+|\/+$/g, "");
  return subdir || undefined;
}

/**
 * Where the module Terraform just fetched ended up on disk.
 *
 * The manifest is the authority, but a `terraform get` that installed the
 * module and then failed to validate the configuration around it leaves no
 * manifest behind - so fall back to the locations Terraform installs into:
 * local modules are read where they are, remote packages are unpacked into
 * `.terraform/modules/<key>`.
 *
 * @internal exposed for testing
 */
export function fetchedModuleDir(
  workingDirectory: string,
  moduleKey: string,
  source: string,
  localSourceAbsolutePath?: string,
): string {
  const manifestPath = path.join(
    workingDirectory,
    ".terraform",
    "modules",
    "modules.json",
  );

  if (fs.existsSync(manifestPath)) {
    const moduleIndex = JSON.parse(
      fs.readFileSync(manifestPath, "utf-8"),
    ) as ModuleIndex;
    const record = moduleIndex.Modules.find((mod) => mod.Key === moduleKey);

    if (record) {
      return path.resolve(workingDirectory, record.Dir);
    }
  }

  if (localSourceAbsolutePath) {
    return localSourceAbsolutePath;
  }

  return path.join(
    workingDirectory,
    ".terraform",
    "modules",
    moduleKey,
    packageSubdir(source) || "",
  );
}

/**
 * Runs `terraform get` and hands the failure back instead of throwing it.
 *
 * Its diagnostics are not final (see {@link readModuleSchema}), so they go to
 * the debug log rather than the terminal; the returned error still carries
 * them on its `stderr` for callers that end up rethrowing it.
 */
async function tryTerraformGet(outdir: string): Promise<Error | undefined> {
  try {
    await exec(
      terraformBinaryName,
      ["get"],
      { cwd: outdir, logStderrAsDebug: true },
      undefined,
      undefined,
      false,
    );
    return undefined;
  } catch (error: any) {
    return error;
  }
}

export async function readModuleSchema(target: ConstructsMakerModuleTarget) {
  let moduleSchema: Record<string, ModuleSchema> = {};

  await withTempDir("fetchSchema", async () => {
    const config: TerraformConfig = {
      terraform: {},
    };

    if (!config.module) config.module = {};
    let source: string = target.source;

    const localSource = (target.constraint as TerraformModuleConstraint)
      .localSourceAbsolutePath;
    if (localSource) {
      // create relative path to module in the user project
      source = path.relative(process.cwd(), localSource);
    }

    config.module[target.moduleKey] = { source: source };
    if (target.version) {
      config.module[target.moduleKey]["version"] = target.version;
    }

    const outdir = process.cwd();
    const filePath = path.join(outdir, "main.tf.json");
    await fs.writeFile(filePath, JSON.stringify(config));

    // `terraform get` is both our downloader and a full validation of the
    // synthetic root config wrapped around the module. A module declaring
    // `configuration_aliases` cannot validate until the root passes those
    // configurations in, and their names are only knowable once the module is
    // on disk - so this first run is a fetch we defer judgement on. Terraform
    // installs the module either way; since 1.15 it just stops short of
    // writing the module manifest when validation fails (terraform#38217
    // dropped the error-to-warning downgrade that `terraform get` used to
    // apply), which is what the second run below restores.
    const fetchError = await tryTerraformGet(outdir);

    const moduleDir = fetchedModuleDir(
      outdir,
      target.moduleKey,
      source,
      localSource,
    );
    const aliases = fs.existsSync(moduleDir)
      ? collectModuleProviderAliases(await convertFiles(moduleDir))
      : [];

    if (aliases.length > 0) {
      applyModuleProviderAliases(config, target.moduleKey, aliases);
      await fs.writeFile(filePath, JSON.stringify(config));
      await exec(terraformBinaryName, ["get"], { cwd: outdir });
    } else if (fetchError) {
      // nothing here was salvageable after all, so report the diagnostics that
      // were held back while the fetch still had a second chance
      logger.error((fetchError as any).stderr || String(fetchError));
      throw fetchError;
    }

    if (config.module) {
      moduleSchema = await harvestModuleSchema(
        outdir,
        Object.keys(config.module),
      );
    }
  });

  return moduleSchema;
}
