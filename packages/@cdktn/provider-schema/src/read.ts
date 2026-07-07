/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

export {
  isRegistryModule,
  TerraformModuleConstraint,
  TerraformProviderConstraint,
  isLocalModule,
} from "@cdktn/commons";
import {
  TerraformDependencyConstraint,
  LANGUAGES,
  ConstructsMakerProviderTarget,
  ConstructsMakerModuleTarget,
  TerraformTargetVersions,
  Errors,
  logger,
} from "@cdktn/commons";
import deepmerge from "deepmerge";
import {
  getFetchingCliVersion,
  readModuleSchema,
  readProviderSchema,
  warnIfSchemaEmissionGaps,
} from "./provider-schema";
import { cachedAccess } from "./cache";

export type Schema = {
  providerSchema?: Awaited<ReturnType<typeof readProviderSchema>>;
  moduleSchema?: Awaited<ReturnType<typeof readModuleSchema>>;
};

// Schema emission is fixed per CLI product+minor version, so that's enough
// granularity for the cache key - no need for the full patch version.
async function resolveCacheKeySuffix(
  cacheDir?: string,
): Promise<string | undefined> {
  if (!cacheDir) return undefined;

  try {
    const cli = await getFetchingCliVersion();
    if (cli.name === "unknown" || !cli.version) {
      logger.debug(
        "Could not determine fetching CLI name/version for the schema cache key, falling back to 'unknown-cli'",
      );
      return "unknown-cli";
    }

    const [major, minor] = cli.version.split(".");
    return `${cli.name}-${major}.${minor}`;
  } catch (error) {
    logger.debug(
      `Could not determine fetching CLI version for the schema cache key: ${error}`,
    );
    return "unknown-cli";
  }
}

export async function readSchema(
  constraints: TerraformDependencyConstraint[],
  cacheDir?: string,
  targetVersions?: TerraformTargetVersions,
): Promise<Schema> {
  const keySuffix = await resolveCacheKeySuffix(cacheDir);
  const cachedReadProviderSchema = cachedAccess(
    readProviderSchema,
    cacheDir,
    keySuffix,
  );
  const targets = constraints.map((constraint) =>
    ConstructsMakerProviderTarget.from(constraint, LANGUAGES[0]),
  );

  throwIfTargetsConflict(targets);

  const schemas = await Promise.all(
    targets.map((t) =>
      t.isModule
        ? readModuleSchema(t as any).then(
            (s) => ({ moduleSchema: s }) as Schema,
          )
        : cachedReadProviderSchema(t as any).then(async (s) => {
            // Runs on both cache hits and misses: cached schemas carry the
            // same cli_name/cli_version stamps a fresh fetch would have
            // written, so the emission-gap warning is just as relevant on
            // a hit as on a miss.
            await warnIfSchemaEmissionGaps(s, targetVersions);
            return { providerSchema: s } as Schema;
          }),
    ),
  );

  // ensure we have a schema for each target type
  schemas.unshift({
    providerSchema: {
      format_version: "0.1",
    },
    moduleSchema: {},
  });

  return deepmerge.all(schemas);
}

function throwIfTargetsConflict(
  targets: (ConstructsMakerProviderTarget | ConstructsMakerModuleTarget)[],
) {
  const modules = targets.filter(
    (t) => t.isModule,
  ) as ConstructsMakerModuleTarget[];

  modules.forEach((moduleA) => {
    modules.forEach((moduleB) => {
      if (moduleA !== moduleB && moduleA.name === moduleB.name) {
        throw Errors.Usage(
          `Found two modules with the same name "${moduleA.name}" which is not supported. Please rename one of the modules in your cdktf.json config. For more information on how to set the name refer to https://cdktn.io/docs/concepts/modules#add-module-to-cdktf-json`,
        );
      }
    });
  });
}
