/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import * as fs from "fs-extra";
import * as path from "path";
import * as semver from "semver";
import { logger } from "./logging";
import { isRegistryModule } from "./terraform-module";
import { env } from "process";
import { toPascalCase } from "codemaker";

export enum Language {
  TYPESCRIPT = "typescript",
  PYTHON = "python",
  CSHARP = "csharp",
  JAVA = "java",
  GO = "go",
}

export const LANGUAGES = [
  Language.TYPESCRIPT,
  Language.PYTHON,
  Language.JAVA,
  Language.CSHARP,
  Language.GO,
];

const CONTEXT_ENV = "CDKTF_CONTEXT_JSON";

const CONFIG_FILE = "cdktf.json";

export interface TypeScriptLanguageOptions {
  /**
   * Suffix to append to relative imports.
   * Defaults to "" (CommonJS).
   * Use ".js" or ".ts" for ESM-compatible imports.
   */
  readonly importExtension?: string;
}

// For now, these languages have no language-specific options.
export type PythonLanguageOptions = Record<string, never>;
export type CSharpLanguageOptions = Record<string, never>;
export type JavaLanguageOptions = Record<string, never>;
export type GoLanguageOptions = Record<string, never>;

export type LanguageOptions =
  | TypeScriptLanguageOptions
  | PythonLanguageOptions
  | CSharpLanguageOptions
  | JavaLanguageOptions
  | GoLanguageOptions;

export const CONFIG_DEFAULTS = {
  output: "cdktf.out",
  codeMakerOutput: ".gen",
};

function isPresent(input: any[] | undefined): boolean {
  return Array.isArray(input) && input.length > 0;
}
export interface TerraformDependencyConstraint {
  readonly name: string;
  readonly source: string;
  readonly version?: string;
  readonly fqn: string;
  readonly namespace?: string;
}

function getLocalMatch(source: string): RegExpMatchArray | null {
  return source.match(/^(\.\/|\.\.\/|\.\\\\|\.\.\\\\)(.*)/);
}

export function isLocalModule(source: string): boolean {
  return getLocalMatch(source) !== null;
}

export class TerraformModuleConstraint implements TerraformDependencyConstraint {
  public readonly name: string;
  public readonly source: string;
  public readonly localSourceAbsolutePath?: string;
  public readonly fqn: string;
  public readonly version?: string;
  public readonly namespace?: string;

  constructor(item: TerraformDependencyConstraint | string) {
    if (typeof item === "string") {
      const parsed = this.parseDependencyConstraint(item);
      this.name = parsed.name;
      this.source = parsed.source;
      this.fqn = parsed.fqn;
      this.version = parsed.version;
      this.namespace = parsed.namespace;
    } else {
      this.source = item.source;
      this.name = item.name;
      this.fqn = item.name;
      this.version = item.version;
      this.namespace = item.namespace;
    }

    const localMatch = getLocalMatch(this.source);
    if (localMatch) {
      this.localSourceAbsolutePath = path.join(process.cwd(), this.source);
    }
  }

  public get className() {
    return toPascalCase(this.name.replace(/[-/.]/g, "_"));
  }

  public get fileName() {
    return this.namespace ? `${this.namespace}/${this.name}` : this.name;
  }

  private parseDependencyConstraint(
    item: string,
  ): TerraformDependencyConstraint {
    const localMatch = getLocalMatch(item);
    if (localMatch) {
      const fqn = localMatch[2];
      const nameParts = fqn.split("/");
      const name = nameParts.pop() ?? fqn;
      const namespace = nameParts.pop();

      return {
        name,
        fqn,
        source: item,
        namespace,
      };
    }

    const [source, version] = item.split("@");
    let moduleParts = source.split("//");
    if (isRegistryModule(moduleParts[0])) {
      const nameParts = moduleParts[0].split("/");
      const provider = nameParts.pop(); // last part is the provider
      let name = nameParts.pop() ?? source;
      let namespace = `${nameParts.pop()}/${provider}`;

      if (moduleParts.length > 1) {
        const moduleNameParts = moduleParts[1].split("/");
        const moduleName = moduleNameParts.pop();
        namespace = `${namespace}/${name}/${moduleNameParts.join("/")}`;
        name = moduleName ?? name;
      }

      return {
        name,
        source,
        version,
        namespace,
        fqn: source.replace("//", "/").replace(/\./g, "-"),
      };
    }

    let toProcess = item; // process one part at a time

    // strip off any prefix
    const prefixMatch = toProcess.match(/^([a-zA-Z0-9]*)::(.*)/);
    if (prefixMatch) {
      toProcess = prefixMatch[2];
    }

    // strip off any protocol
    const protocolMatch = toProcess.match(/^([a-zA-Z]*):\/\/(.*)/);
    if (protocolMatch) {
      toProcess = protocolMatch[2];
    }

    // anything before last ':' won't contribute
    const colonParts = toProcess.split(":");
    toProcess = colonParts.pop() ?? toProcess;

    // strip off any port
    const portMatch = toProcess.match(/^[\d]*(.*)/);
    if (portMatch) {
      toProcess = portMatch[1];
    }

    // strip off any hostname
    const hostMatch = toProcess.match(/[^/]*\.[^/]*\/(.*)/);
    if (hostMatch) {
      toProcess = hostMatch[1];
    }

    // strip off any arguments
    const argumentMatch = toProcess.match(/(.*)\?.*/);
    if (argumentMatch) {
      toProcess = argumentMatch[1];
    }

    // strip off any types
    toProcess = toProcess.replace(/\.git|\.hg|\.zip/, "");

    moduleParts = toProcess.split("//");
    const nameParts = moduleParts[0].split("/");
    let name = nameParts.pop();
    let namespace = nameParts.pop();
    if (!name) {
      throw new Error(`Module name should be properly set in ${item}`);
    }

    if (moduleParts.length > 1) {
      const moduleNameParts = moduleParts[1].split("/");
      const moduleName = moduleNameParts.pop();
      if (namespace) {
        namespace = `${namespace}/${name}/${moduleNameParts.join("/")}`;
      } else {
        namespace = `${name}/${moduleNameParts.join("/")}`;
      }
      name = moduleName ?? name;
    }

    return {
      name,
      source: item,
      fqn: toProcess.replace("//", "/"),
      namespace,
    };
  }
}

export class TerraformProviderConstraint implements TerraformDependencyConstraint {
  public readonly name: string;
  public readonly source: string;
  public readonly version?: string;
  public readonly fqn: string;
  public readonly namespace?: string;

  constructor(item: Omit<TerraformDependencyConstraint, "fqn"> | string) {
    if (typeof item === "string") {
      const parsed = this.parseDependencyConstraint(item);
      this.name = parsed.name;
      this.fqn = parsed.fqn;
      this.source = parsed.fqn;
      this.version = parsed.version;
      this.namespace = parsed.namespace;
    } else {
      this.name = item.name;
      this.fqn = item.name;
      this.version = item.version;
      this.source = item.source;
      this.namespace = item.namespace;
    }
  }

  private parseDependencyConstraint(
    item: string,
  ): TerraformDependencyConstraint {
    const [fqn, version] = item.split("@");
    const nameParts = fqn.split("/");
    const name = nameParts.pop();
    const namespace = nameParts.pop();
    if (!name) {
      throw new Error(`Provider name should be properly set in ${item}`);
    }

    return {
      name,
      source: fqn,
      // Terraform doesn't support *, instead no version is specified
      version: version === "*" ? undefined : version,
      fqn,
      namespace,
    };
  }
}

// The targetVersions vocabulary is owned by the cdktn package (its canonical
// home; cdktn must not depend on commons, so the dependency goes this way).
// The data type and default baseline are part of cdktn's public API and
// imported from the package root; the context key and product list are
// internal wiring imported via subpath.
import { DEFAULT_TARGET_VERSIONS, TerraformTargetVersions } from "cdktn";
import {
  TARGET_PRODUCTS,
  TARGET_VERSIONS_CONTEXT_KEY,
} from "cdktn/lib/validations";

// Re-exported so existing commons consumers (e.g. @cdktn/cli-core) keep a
// single import surface.
export { DEFAULT_TARGET_VERSIONS };
export type { TerraformTargetVersions };

interface ConfigBase {
  readonly app?: string;
  readonly output: string;
  readonly codeMakerOutput: string;
  terraformProviders?: TerraformProviderConstraint[];
  terraformModules?: TerraformModuleConstraint[];
  readonly context?: { [key: string]: any };
  readonly targetVersions?: TerraformTargetVersions;
  /**
   * When true, commands that execute the Terraform-compatible CLI (diff,
   * deploy, destroy) verify that the installed binary satisfies the declared
   * `targetVersions` before running it.
   */
  readonly validateInstalledBinary?: boolean;
}

/**
 * Validates the shape of a `targetVersions` declaration; returns a list of
 * human-readable problems (empty when valid).
 */
export function validateTargetVersions(targetVersions: unknown): string[] {
  if (targetVersions === undefined) return [];

  if (
    typeof targetVersions !== "object" ||
    targetVersions === null ||
    Array.isArray(targetVersions)
  ) {
    return [
      `targetVersions must be an object mapping products to semver ranges, e.g. { "terraform": ">=1.5.7" }`,
    ];
  }

  const entries = Object.entries(targetVersions);
  if (entries.length === 0) {
    return [
      `targetVersions must declare at least one product ("terraform" or "opentofu") or be omitted entirely`,
    ];
  }

  const problems: string[] = [];
  for (const [product, range] of entries) {
    if (!(TARGET_PRODUCTS as readonly string[]).includes(product)) {
      problems.push(
        `targetVersions has unknown product "${product}" (expected "terraform" or "opentofu")`,
      );
      continue;
    }
    if (typeof range !== "string") {
      problems.push(
        `targetVersions.${product} must be a semver range string, got ${JSON.stringify(
          range,
        )}`,
      );
      continue;
    }
    if (range.includes("~>")) {
      problems.push(
        `targetVersions.${product} "${range}" uses Terraform provider constraint syntax; use npm semver ranges instead (e.g. ">=1.5.7" or "~1.5.7")`,
      );
      continue;
    }
    if (semver.validRange(range) === null) {
      problems.push(
        `targetVersions.${product} "${range}" is not a valid semver range`,
      );
    }
  }

  return problems;
}

/**
 * Language-specific code generation options, discriminated by `language`.
 * Only TypeScript currently has tunable options; all other languages
 * accept an empty `languageOptions` object as a future extension point.
 */
export type Config = ConfigBase &
  (
    | {
        readonly language?: Language.TYPESCRIPT;
        readonly languageOptions?: TypeScriptLanguageOptions;
      }
    | {
        readonly language: Language.PYTHON;
        readonly languageOptions?: PythonLanguageOptions;
      }
    | {
        readonly language: Language.CSHARP;
        readonly languageOptions?: CSharpLanguageOptions;
      }
    | {
        readonly language: Language.JAVA;
        readonly languageOptions?: JavaLanguageOptions;
      }
    | {
        readonly language: Language.GO;
        readonly languageOptions?: GoLanguageOptions;
      }
  );

export const parseConfig = (configJSON?: string) => {
  const config: Config = {
    ...CONFIG_DEFAULTS,
    ...JSON.parse(configJSON || "{}"),
  };

  if (isPresent(config.terraformModules)) {
    config.terraformModules = config.terraformModules?.map(
      (mod) => new TerraformModuleConstraint(mod),
    );
  }

  if (isPresent(config.terraformProviders)) {
    config.terraformProviders = config.terraformProviders?.map(
      (provider) => new TerraformProviderConstraint(provider),
    );
  }

  const targetVersionProblems = validateTargetVersions(config.targetVersions);
  if (targetVersionProblems.length > 0) {
    throw new Error(
      `Invalid ${CONFIG_FILE}:\n  ${targetVersionProblems.join("\n  ")}`,
    );
  }

  // declared target versions ride along in the context so they reach the
  // synthesized app without a separate channel
  const context = {
    ...config.context,
    ...(config.targetVersions
      ? { [TARGET_VERSIONS_CONTEXT_KEY]: config.targetVersions }
      : {}),
  };
  if (Object.keys(context).length > 0) {
    env[CONTEXT_ENV] = JSON.stringify(context);
  }

  return config;
};

export function readConfigSync(
  configFile = path.join(process.cwd(), CONFIG_FILE),
): Config {
  let configFileContent: string | undefined;

  if (fs.existsSync(configFile)) {
    configFileContent = fs.readFileSync(configFile).toString();
  }

  return parseConfig(configFileContent);
}

export function shouldCheckCodeMakerOutput(config: Config): boolean {
  return (
    isPresent(config.terraformModules) || isPresent(config.terraformProviders)
  );
}

export function logTimespan(message: string) {
  logger.debug(`Start timer for ${message}...`);
  const start = Date.now();

  return function logTimespanEnd() {
    const end = Date.now();
    const duration = end - start;
    logger.debug(`${message} took ${duration}ms`);
  };
}
