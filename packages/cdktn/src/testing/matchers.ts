// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { execSync, SpawnSyncReturns } from "child_process";
import { snakeCase, terraformBinaryName } from "../util";
import {
  invalidStack,
  matchersFoundErrorsInStack,
  matchersPathIsNotDirectory,
} from "../errors";

export interface TerraformConstructor {
  readonly tfResourceType: string;
}

export type SynthesizedStack = {
  resource: Record<string, any>;
  data: Record<string, any>;
  provider: Record<string, any>;
};

/**
 * The result of a testing matcher assertion.
 */
export class AssertionReturn {
  constructor(
    public readonly message: string,
    public readonly pass: boolean,
  ) {}
}

export type MatcherReturnJest = { message: () => string; pass: boolean };

/**
 * Adapts an {@link AssertionReturn} to Jest's `{ message, pass }` matcher shape.
 */
export function returnMatcherToJest(
  toReturn: AssertionReturn,
): MatcherReturnJest {
  return {
    message: () => toReturn.message,
    pass: toReturn.pass,
  };
}

/**
 * Deep-equals `expected` against `received`, ignoring extra properties on `received` and
 * matching each key in either camelCase or snake_case.
 */
export function asymetricDeepEqualIgnoringObjectCasing(
  expected: unknown,
  received: unknown,
): boolean {
  switch (typeof expected) {
    case "object":
      if (Array.isArray(expected)) {
        return (
          Array.isArray(received) &&
          expected.length === received.length &&
          expected.every((item, index) =>
            asymetricDeepEqualIgnoringObjectCasing(item, received[index]),
          )
        );
      }
      if (expected === null && received === null) {
        return true;
      }
      if (expected === undefined && received === undefined) {
        return true;
      }
      if (expected === null || received === null) {
        return false;
      }

      return Object.keys(expected as Record<string, unknown>).every((key) => {
        if ((received as any)[key] !== undefined) {
          return asymetricDeepEqualIgnoringObjectCasing(
            (expected as any)[key],
            (received as any)[key],
          );
        }

        if ((received as any)[snakeCase(key)] !== undefined) {
          return asymetricDeepEqualIgnoringObjectCasing(
            (expected as any)[key],
            (received as any)[snakeCase(key)],
          );
        }

        return false;
      });
    default:
      return expected === received;
  }
}
const defaultPassEvaluation = (
  items: any,
  assertedProperties: Record<string, any>,
) => {
  return Object.values(items).some((item: any) =>
    asymetricDeepEqualIgnoringObjectCasing(assertedProperties, item),
  );
};

// eslint-disable-next-line jsdoc/require-jsdoc
function isAsymmetric(obj: any) {
  return !!obj && typeof obj === "object" && "asymmetricMatch" in obj;
}
// Renders jest asymmetric matchers (expect.anything(), etc.) as "expect.Anything()" in messages,
// instead of their internal object representation.
// eslint-disable-next-line jsdoc/require-jsdoc
function jestAsymetricMatcherStringifyReplacer(_key: string, value: any) {
  return isAsymmetric(value) ? `expect.${value.toString()}` : value;
}
// eslint-disable-next-line jsdoc/require-jsdoc
function getAssertElementWithProperties(
  functionName: string,
  // Configurable so each adapter (Jest, Vitest, ...) can use its own matcher semantics.
  customPassEvaluation?: (
    items: any[],
    assertedProperties: Record<string, any>,
  ) => boolean,
) {
  const passEvaluation = customPassEvaluation || defaultPassEvaluation;
  return function getAssertElementWithProperties(
    type: keyof SynthesizedStack,
    received: string,
    itemType: TerraformConstructor,
    properties: Record<string, any> = {},
  ): AssertionReturn {
    let stack: SynthesizedStack;

    // received may be a JSON string or a path to a file containing one
    const stackContent = fs.existsSync(received)
      ? fs.readFileSync(received, "utf8")
      : received;

    try {
      stack = JSON.parse(stackContent) as SynthesizedStack;
    } catch (e) {
      throw invalidStack(functionName, stackContent);
    }

    // find every item of itemType.tfResourceType under stack[type], keyed by name
    const items =
      Object.values(
        Object.entries(stack[type] || {}).find(
          ([type, _values]) => type === itemType.tfResourceType,
        )?.[1] || {},
      ) || [];
    const pass = passEvaluation(items, properties);
    if (pass) {
      return new AssertionReturn(
        `Expected no ${
          itemType.tfResourceType
        } with properties ${JSON.stringify(
          properties,
          jestAsymetricMatcherStringifyReplacer,
        )} to be present in synthesized stack.
Found ${items.length === 0 ? "no" : items.length} ${
          itemType.tfResourceType
        } resources instead${
          items.length > 0 ? ":\n" + JSON.stringify(items, null, 2) : ""
        }`,
        pass,
      );
    } else {
      return new AssertionReturn(
        `Expected ${itemType.tfResourceType} with properties ${JSON.stringify(
          properties,
          jestAsymetricMatcherStringifyReplacer,
        )} to be present in synthesized stack.
Found ${items.length === 0 ? "no" : items.length} ${
          itemType.tfResourceType
        } resources instead${
          items.length > 0 ? ":\n" + JSON.stringify(items, null, 2) : ""
        }`,
        pass,
      );
    }
  };
}

/**
 * Returns a `toHaveDataSourceWithProperties` matcher using `customPassEvaluation` to decide a
 * match.
 */
export function getToHaveDataSourceWithProperties(
  customPassEvaluation?: (
    items: any,
    assertedProperties: Record<string, any>,
  ) => boolean,
) {
  return function toHaveDataSourceWithProperties(
    received: string,
    resourceType: TerraformConstructor,
    properties: Record<string, any> = {},
  ): AssertionReturn {
    return getAssertElementWithProperties(
      "toHaveDataSourceWithProperties",
      customPassEvaluation,
    )("data", received, resourceType, properties);
  };
}

/**
 * Returns a `toHaveResourceWithProperties` matcher using `customPassEvaluation` to decide a
 * match.
 */
export function getToHaveResourceWithProperties(
  customPassEvaluation?: (
    items: any,
    assertedProperties: Record<string, any>,
  ) => boolean,
) {
  return function toHaveResourceWithProperties(
    received: string,
    resourceType: TerraformConstructor,
    properties: Record<string, any> = {},
  ): AssertionReturn {
    return getAssertElementWithProperties(
      "toHaveResourceWithProperties",
      customPassEvaluation,
    )("resource", received, resourceType, properties);
  };
}

/**
 * Reports whether `err` carries `child_process.execSync`/`spawnSync` output buffers.
 */
const isExecSpawnError = (err: any): err is Error & SpawnSyncReturns<any> =>
  "output" in err &&
  Array.isArray(err.output) &&
  err.output.some((buf: any) => Buffer.isBuffer(buf));

/**
 * Renders terraform diagnostic entries as human-readable text.
 */
const formatDiagnostics = (diagnostics: any[]): string =>
  diagnostics
    .filter((d) => d?.severity && d?.summary)
    .map(
      ({ severity, summary, detail }) =>
        `${severity}: ${summary}${detail ? `\n${detail}` : ""}`,
    )
    .join("\n");

/**
 * Renders the diagnostics found in the output of a `terraform <cmd> -json` invocation as
 * human-readable text. Handles both `plan`'s newline-delimited JSON stream (one `diagnostic`
 * entry per line) and `validate`'s single pretty-printed object (a top-level `diagnostics`
 * array).
 */
const renderJsonDiagnostics = (output: string): string => {
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed?.diagnostics)) {
      return formatDiagnostics(parsed.diagnostics);
    }
  } catch {
    // not a single JSON object; fall through to the newline-delimited format
  }

  const diagnostics = output
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((entry) => entry?.type === "diagnostic" && entry.diagnostic)
    .map((entry) => entry.diagnostic);

  return formatDiagnostics(diagnostics);
};

/**
 * Appends a failed process's output to an assertion message, preferring rendered `-json`
 * diagnostics over the raw output when available.
 */
const withProcessOutput = (message: string, err: unknown) => {
  if (!isExecSpawnError(err)) {
    return `${message}: ${err}.`;
  }

  const output =
    err.output
      ?.map((buffer: Buffer) => buffer?.toString("utf8"))
      .filter(Boolean)
      .join("\n") ?? "";

  // Diagnostics are parsed from stdout alone: concatenating stderr (e.g. a CLI-config error)
  // into the mix would break the single-object parse `-json` output relies on.
  const diagnostics = renderJsonDiagnostics(err.stdout?.toString("utf8") ?? "");
  const appendix = diagnostics.length
    ? `. Diagnostics: ${diagnostics}`
    : output.length
      ? `. Output: ${output}`
      : "";

  return `${message}: ${err}${appendix}.`;
};

/**
 * Returns a `toHaveProviderWithProperties` matcher using `customPassEvaluation` to decide a
 * match.
 */
export function getToHaveProviderWithProperties(
  customPassEvaluation?: (
    items: any,
    assertedProperties: Record<string, any>,
  ) => boolean,
) {
  return function toHaveProviderWithProperties(
    received: string,
    resourceType: TerraformConstructor,
    properties: Record<string, any> = {},
  ): AssertionReturn {
    return getAssertElementWithProperties(
      "toHaveProviderWithProperties",
      customPassEvaluation,
    )("provider", received, resourceType, properties);
  };
}

/**
 * The root directory the provider lock-file cache is written under. Overridable via
 * `CDKTN_TESTING_LOCKFILE_CACHE_DIR` so tests can assert on what gets written to it instead of
 * sharing the real machine-global cache, and so CI can point it at a directory persisted
 * between jobs.
 */
function getProviderLockFileCacheRoot(): string {
  return (
    process.env.CDKTN_TESTING_LOCKFILE_CACHE_DIR ??
    path.join(os.tmpdir(), "cdktn-testing-provider-lockfiles")
  );
}

// A loosely pinned requirement (e.g. "~> 5.0") shouldn't stay pinned to whichever version a
// machine first resolved forever, so the cache expires.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const binaryVersionCache = new Map<string, string>();

// eslint-disable-next-line jsdoc/require-jsdoc
function getBinaryVersion(binaryName: string, env: NodeJS.ProcessEnv): string {
  const cached = binaryVersionCache.get(binaryName);
  if (cached) {
    return cached;
  }

  let version = "unknown";
  try {
    version = execSync(`${binaryName} version`, { env, stdio: "pipe" })
      .toString("utf8")
      .split("\n")[0];
  } catch {
    // only affects cache partitioning, so "unknown" is an acceptable fallback
  }

  binaryVersionCache.set(binaryName, version);
  return version;
}

// eslint-disable-next-line jsdoc/require-jsdoc
function getProviderLockCacheDir(
  workingDir: string,
  binaryName: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(workingDir, "cdk.tf.json"), "utf8"),
    );
    const cacheKey = crypto
      .createHash("sha256")
      .update(binaryName)
      .update(getBinaryVersion(binaryName, env))
      .update(JSON.stringify(config?.terraform?.required_providers ?? {}))
      .digest("hex");
    return path.join(getProviderLockFileCacheRoot(), cacheKey);
  } catch {
    return undefined;
  }
}

// eslint-disable-next-line jsdoc/require-jsdoc
function isCachedLockFileFresh(cachedLockFile: string): boolean {
  try {
    return Date.now() - fs.statSync(cachedLockFile).mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Copies a cached `.terraform.lock.hcl` into `workingDir` if `warmUpProviderLockFileCache` has
 * already resolved one for its exact set of required providers, and it hasn't expired. Never
 * runs `init` itself. A `workingDir` that already has its own lock file is left untouched —
 * real stack directories keep a pinned one (`cli-core` reads it from there), and overwriting it
 * with the cached one would silently swap its versions.
 *
 * @returns whether a lock file was seeded.
 */
function seedFromWarmCache(
  workingDir: string,
  binaryName: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const targetLockFile = path.join(workingDir, ".terraform.lock.hcl");
  if (fs.existsSync(targetLockFile)) {
    return false;
  }

  const cacheDir = getProviderLockCacheDir(workingDir, binaryName, env);
  if (!cacheDir) {
    return false;
  }

  const cachedLockFile = path.join(cacheDir, ".terraform.lock.hcl");
  if (!isCachedLockFileFresh(cachedLockFile)) {
    return false;
  }

  fs.copyFileSync(cachedLockFile, targetLockFile);
  return true;
}

/**
 * Removes `TF_PLUGIN_CACHE_DIR` from `env`. Without a seeded lock file, `init` resolves
 * providers itself; against terraform >= 1.4 that re-downloads into the shared plugin cache
 * even when it's warm, racing other concurrent `init`s
 * (https://github.com/open-constructs/cdk-terrain/issues/452). Dropping the cache dir from the
 * environment makes `init` resolve into the stack's own `.terraform` directory instead, so it
 * can't race another worker's writes to the shared cache. This doesn't cover a `plugin_cache_dir`
 * set in the user's CLI config file rather than the environment, and
 * `warmUpProviderLockFileCache` is still expected to run once per machine at a time — two warm-ups
 * racing a cold plugin cache would hit the same race this works around.
 */
function withoutPluginCache(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { TF_PLUGIN_CACHE_DIR: _unused, ...rest } = env;
  return rest;
}

/**
 * Resolves and caches a `.terraform.lock.hcl` for the exact set of required providers in
 * `workingDir`, running a real `init` against the shared plugin cache. Only ever called from
 * `warmUpProviderLockFileCache`, which runs serially within a single process, so no cross-
 * process lock is needed: it's the only writer to the cache.
 *
 * `init` always runs, even when a fresh cached lock file exists: the lock-file cache and
 * `TF_PLUGIN_CACHE_DIR` have independent lifetimes, so a fresh lock doesn't guarantee the
 * providers it pins are still sitting in the plugin cache. Seeding the cached lock first (when
 * `workingDir` doesn't already have one of its own, and the cache hasn't expired) just lets
 * that `init` take the verified-checksum path instead of resolving from scratch. A stale cache
 * is left alone so `init` re-resolves it, otherwise a loosely pinned requirement (e.g. `~> 5.0`)
 * would stay pinned to whatever version this cache entry first resolved, forever.
 */
function resolveAndCacheProviderLockFile(
  workingDir: string,
  binaryName: string,
  env: NodeJS.ProcessEnv,
): void {
  const cacheDir = getProviderLockCacheDir(workingDir, binaryName, env);
  if (!cacheDir) {
    return;
  }

  const targetLockFile = path.join(workingDir, ".terraform.lock.hcl");
  const cachedLockFile = path.join(cacheDir, ".terraform.lock.hcl");
  const hadOwnLockFile = fs.existsSync(targetLockFile);
  if (!hadOwnLockFile && isCachedLockFileFresh(cachedLockFile)) {
    try {
      fs.copyFileSync(cachedLockFile, targetLockFile);
    } catch {
      // lost a race to another writer; init resolves a lock file from scratch below
    }
  }

  execSync(`${binaryName} init -backend=false -input=false`, {
    cwd: workingDir,
    env,
    stdio: "pipe",
  });

  if (hadOwnLockFile) {
    // only cache lock files this warm-up actually resolved, not a stack's own pinned one
    return;
  }

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmpLockFile = `${cachedLockFile}.${process.pid}.tmp`;
    fs.copyFileSync(targetLockFile, tmpLockFile);
    fs.renameSync(tmpLockFile, cachedLockFile);
  } catch {
    // the cache write-back is an optimization only; a failure here must not fail the warm-up
  }
}

// eslint-disable-next-line jsdoc/require-jsdoc
function getManifestStacks(
  received: string,
): [string, { workingDirectory: string }][] {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(received, "manifest.json"), "utf8"),
  );
  return Object.entries(manifest.stacks);
}

/**
 * Resolves and caches a `.terraform.lock.hcl` for every unique required-providers set across
 * the given `fullSynth` output directories, up front and serially.
 *
 * Intended for callers that know the full set of stacks under test ahead of time — e.g. a
 * Jest/Vitest `globalSetup` hook, before parallel workers start — so there's nothing left for
 * `toBeValidTerraform`/`toPlanSuccessfully` to race over
 * (https://github.com/open-constructs/cdk-terrain/issues/452).
 *
 * @param received one or more `fullSynth` output directories to warm up
 */
export function warmUpProviderLockFileCache(received: string[]): void {
  received
    .flatMap((dir) =>
      getManifestStacks(dir).map(([, stack]) =>
        path.resolve(dir, stack.workingDirectory),
      ),
    )
    .forEach((workingDir) =>
      resolveAndCacheProviderLockFile(
        workingDir,
        terraformBinaryName,
        process.env,
      ),
    );
}

// execSync's default 1 MiB maxBuffer is easily exceeded by `-json` output for a plan/validate
// of more than a few dozen resources.
const EXEC_MAX_BUFFER = 100 * 1024 * 1024;

/**
 * Checks that the received stack is valid Terraform (`terraform validate`).
 */
export function toBeValidTerraform(received: string): AssertionReturn {
  try {
    if (!fs.statSync(received).isDirectory()) {
      throw matchersPathIsNotDirectory("toBeValidTerraform");
    }
  } catch (e) {
    return new AssertionReturn(
      `Expected subject to be a terraform directory: ${e}`,
      false,
    );
  }

  try {
    const stacks = getManifestStacks(received);

    stacks.forEach(([name, stack]) => {
      const opts = {
        cwd: path.resolve(received, stack.workingDirectory),
        env: process.env,
        stdio: "pipe",
        maxBuffer: EXEC_MAX_BUFFER,
      } as any;
      const seeded = seedFromWarmCache(opts.cwd, terraformBinaryName, opts.env);
      execSync(`${terraformBinaryName} init -backend=false -input=false`, {
        ...opts,
        env: seeded ? opts.env : withoutPluginCache(opts.env),
      });
      const out = execSync(`${terraformBinaryName} validate -json`, opts);

      const result = JSON.parse(out.toString());
      if (!result.valid) {
        throw matchersFoundErrorsInStack(
          result.error_count,
          name,
          result.diagnostics.join("\n"),
        );
      }
    });
    return new AssertionReturn(
      `Expected subject not to be a valid terraform stack`,
      true,
    );
  } catch (e) {
    return new AssertionReturn(
      withProcessOutput(`Expected subject to be a valid terraform stack`, e),
      false,
    );
  }
}

export interface ToPlanSuccessfullyOptions {
  /**
   * Whether `init`/`plan` should use the stack's real backend. Disable this for stacks whose
   * backend (e.g. s3, remote) is not reachable in the test environment and whose plan does not
   * depend on existing state.
   * @default true
   */
  readonly backend?: boolean;
}

const noRealBackendOverrideFileName =
  "cdktn-testing-no-backend_override.tf.json";

/**
 * `init -backend=false` leaves the backend uninitialized, which `plan` refuses to run against
 * (`fullSynth` output always has a backend block). Write a Terraform JSON override that swaps
 * in a `local` backend instead, so `init` can initialize for real without credentials or
 * network access.
 */
function overrideWithLocalBackend(workingDir: string) {
  fs.writeFileSync(
    path.join(workingDir, noRealBackendOverrideFileName),
    JSON.stringify({ terraform: { backend: { local: {} } } }),
  );
}

// eslint-disable-next-line jsdoc/require-jsdoc
function removeLocalBackendOverride(workingDir: string) {
  fs.rmSync(path.join(workingDir, noRealBackendOverrideFileName), {
    force: true,
  });
}

/**
 * Checks that the received stack plans successfully (`terraform plan`).
 */
export function toPlanSuccessfully(
  received: string,
  options: ToPlanSuccessfullyOptions = {},
): AssertionReturn {
  const { backend = true } = options;

  try {
    if (!fs.statSync(received).isDirectory()) {
      throw matchersPathIsNotDirectory("toPlanSuccessfully");
    }
  } catch (e) {
    return new AssertionReturn(
      `Expected subject to be a terraform directory: ${e}`,
      false,
    );
  }

  try {
    const stacks = getManifestStacks(received);

    stacks.forEach(([, stack]) => {
      const opts = {
        cwd: path.resolve(received, stack.workingDirectory),
        env: process.env,
        stdio: "pipe",
        maxBuffer: EXEC_MAX_BUFFER,
      } as any;

      if (!backend) {
        overrideWithLocalBackend(opts.cwd);
      }

      try {
        const seeded = seedFromWarmCache(
          opts.cwd,
          terraformBinaryName,
          opts.env,
        );
        execSync(`${terraformBinaryName} init -input=false`, {
          ...opts,
          env: seeded ? opts.env : withoutPluginCache(opts.env),
        });

        // throws on a non-zero exit code
        execSync(
          `${terraformBinaryName} plan -input=false -lock=false -json`,
          opts,
        );
      } finally {
        if (!backend) {
          removeLocalBackendOverride(opts.cwd);
        }
      }
    });

    return new AssertionReturn(
      `Expected subject not to plan successfully`,
      true,
    );
  } catch (e) {
    return new AssertionReturn(
      withProcessOutput(`Expected subject to plan successfully`, e),
      false,
    );
  }
}
