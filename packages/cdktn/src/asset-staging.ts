// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct, IConstruct } from "constructs";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AssetHashType,
  AssetOptions,
  IAsset,
  IAssetBundler,
  IAssetPackaging,
} from "./assets";
import {
  assetFilePackagingWithBundlerUnsupported,
  assetHashConflictingExcludeOptions,
  assetHashConflictingHashType,
  assetHashInvalid,
  assetHashTypeCustomRequiresHash,
  assetHashTypeUnknown,
  assetStagingAlreadyStaged,
  assetStagingBundlerOutputNotDirectory,
} from "./errors";
import { CANONICAL_ASSET_HASHES } from "./features";
import { ExcludeIgnoreStrategy, IIgnoreStrategy } from "./ignore-strategy";
import { copySync, hashPath } from "./private/fs";

// A resolved hash is used verbatim as a path segment (see `TerraformAsset.path`),
// so it may only contain characters that are always safe there.
const SAFE_ASSET_HASH = /^[A-Za-z0-9_.-]+$/;

/**
 * Context key for a value folded into every computed asset hash in the
 * construct tree, alongside `extraHash`. A bulk cache-busting escape hatch —
 * `extraHash` is scoped to one asset, this is scoped to the whole app.
 */
export const ASSET_HASH_SALT_CONTEXT_KEY = "cdktn:assetHashSalt";

/**
 * Caches the base (pre `extraHash`/salt) hash of a `SOURCE`/`OUTPUT` walk,
 * so that multiple `AssetStaging` instances with identical inputs — the same
 * asset referenced from more than one resource or stack — hash the source
 * tree once per synth instead of once per reference.
 *
 * Keyed per construct-tree root (the `App`) rather than at module scope: an
 * App instance lives exactly as long as one synth, so a long-running process
 * that synths repeatedly against changing files (e.g. `cdktn watch`) always
 * gets a fresh cache instead of a stale hash from a previous synth.
 */
const hashCachesByRoot = new WeakMap<IConstruct, Map<string, string>>();

/**
 * @param root - the construct tree root to scope the cache to, see {@link hashCachesByRoot}
 */
function hashCacheFor(root: IConstruct): Map<string, string> {
  let cache = hashCachesByRoot.get(root);
  if (!cache) {
    cache = new Map();
    hashCachesByRoot.set(root, cache);
  }
  return cache;
}

/**
 * Eager-build scratch directories awaiting cleanup, swept on process exit or
 * an interrupting signal.
 *
 * An `OUTPUT`-hash build runs in the constructor but is normally torn down in
 * `stage()`. When the asset's stack is not synthesized this pass, `stage()`
 * never runs, so the sweep reclaims what can be large trees (`node_modules`,
 * build caches) that `os.tmpdir()` does not clear reliably.
 */
const strandedScratchDirs = new Set<string>();
let exitSweepInstalled = false;

/**
 * Synchronously remove every still-registered scratch directory.
 */
function sweepStrandedScratch(): void {
  for (const stray of strandedScratchDirs) {
    try {
      fs.rmSync(stray, { recursive: true, force: true });
    } catch {
      // Best-effort on the way out; nothing useful to do if it fails.
    }
  }
  strandedScratchDirs.clear();
}

/**
 * Track a scratch directory for removal if it survives to process exit.
 *
 * `exit` alone misses a Ctrl-C or a `kill` during synth — exactly when the
 * largest trees (`node_modules`, build caches) are left behind — because Node
 * does not run `exit` handlers on `SIGINT`/`SIGTERM`. The signal handlers
 * sweep, then re-raise the signal so any other listeners (the CLI's own) still
 * run, or the default disposition terminates the process if there are none.
 */
function registerStrandedScratch(dir: string): void {
  strandedScratchDirs.add(dir);
  if (!exitSweepInstalled) {
    exitSweepInstalled = true;
    // `exit` handlers must be synchronous; `rmSync` is.
    process.once("exit", sweepStrandedScratch);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        sweepStrandedScratch();
        // Re-raise so the signal is not swallowed. `process.once` has already
        // removed this listener, so the re-raise reaches whatever else is
        // registered — the CLI's own SIGINT/SIGTERM handlers — or, if nothing
        // is, the default disposition that terminates the process. Removing
        // other listeners here would discard exactly those the app relies on.
        process.kill(process.pid, signal);
      });
    }
  }
}

/**
 * Options for {@link AssetStaging}.
 */
export interface AssetStagingOptions extends AssetOptions {
  /**
   * Absolute path to the source file or directory. Resolving a relative path
   * against `cdktf.json` is the caller's responsibility.
   */
  readonly sourcePath: string;

  /**
   * How the staged result is produced and shaped. The caller decides this
   * (e.g. from its own `AssetType`) — `AssetStaging` never infers or changes
   * it based on `exclude`/`extraHash`.
   */
  readonly packaging: IAssetPackaging;

  /**
   * Paths to exclude, relative to `sourcePath`. Cannot be combined with
   * `ignoreStrategy`, which replaces this matcher rather than layering on
   * top of it.
   *
   * @default - nothing is excluded
   */
  readonly exclude?: string[];

  /**
   * Exclusion matching, for callers that need `.gitignore` / `.dockerignore`
   * parity rather than the built-in exact-path / suffix / directory matcher.
   *
   * @default - `exclude` is used with the built-in matcher
   */
  readonly ignoreStrategy?: IIgnoreStrategy;

  /**
   * Extra information to fold into the hash (e.g. build instructions and
   * other inputs).
   *
   * @default - no extra hash
   */
  readonly extraHash?: string;

  /**
   * A bundler that builds the source into an artifact before staging.
   *
   * Under the default `SOURCE` hashing the build is deferred to `stage()` and
   * stays skippable; `OUTPUT` hashing builds eagerly at construction time to
   * hash the artifact, forgoing skippability. A bundler always produces a
   * directory, so single-file packaging (`AssetType.FILE`) is rejected.
   *
   * @default - the source is staged verbatim, with no build step
   */
  readonly bundler?: IAssetBundler;

  /**
   * Identifier used in error messages, so they name the user-facing construct
   * (e.g. the `TerraformAsset`) rather than this internal staging child.
   *
   * @default - the staging construct's own id
   */
  readonly displayName?: string;
}

/**
 * Resolves an asset's identity and stages its content to disk.
 *
 * The hash is available immediately after construction; the filesystem write
 * is deferred to `stage()`, the one window where it is safe. Hashing is
 * cached per synth (see {@link hashCachesByRoot}) so an asset referenced from
 * several places is walked once. Without a bundler, `SOURCE` and `OUTPUT` both
 * hash the source; with one they diverge, as `AssetStagingOptions.bundler`
 * describes.
 */
export class AssetStaging extends Construct implements IAsset {
  private readonly sourcePath: string;
  private readonly displayName: string;
  private readonly ignoreStrategy: IIgnoreStrategy;
  private readonly hasExclusions: boolean;
  private readonly hashCache: Map<string, string>;
  private readonly bundler?: IAssetBundler;

  /**
   * Output of an eager `OUTPUT`-hash build, carried to `stage()` for reuse.
   *
   * Undefined on every other path, where the build is deferred or absent.
   */
  private eagerBuild?: { readonly scratch: string; readonly produced: string };

  /**
   * Set once `stage()` has run, so a second call cannot rebuild. An eager
   * `OUTPUT` build is captured at construction and consumed by the first
   * `stage()`; without this guard a second call would fall through to the
   * deferred build path and stage bytes that no longer match the hash.
   */
  private staged = false;

  public readonly packaging: IAssetPackaging;
  public readonly isDirectory: boolean;
  public readonly assetHash: string;

  public constructor(scope: Construct, id: string, props: AssetStagingOptions) {
    super(scope, id);

    this.sourcePath = props.sourcePath;
    this.displayName = props.displayName ?? id;
    this.packaging = props.packaging;
    this.isDirectory = props.packaging.producesDirectory;
    this.hashCache = hashCacheFor(this.node.root);
    this.bundler = props.bundler;

    if (props.exclude?.length && props.ignoreStrategy) {
      throw assetHashConflictingExcludeOptions();
    }
    this.ignoreStrategy =
      props.ignoreStrategy ?? new ExcludeIgnoreStrategy(props.exclude ?? []);
    // A custom strategy is assumed to exclude something; the built-in one only
    // does with a non-empty `exclude`. Drives whether the bundler is handed a
    // materialised filtered copy or the source directly.
    this.hasExclusions =
      props.ignoreStrategy !== undefined || !!props.exclude?.length;

    // A bundler always produces a directory, so packaging that cannot take a
    // directory source would fail with an opaque EISDIR/EPERM at synth.
    if (this.bundler && !this.packaging.acceptsDirectorySource) {
      throw assetFilePackagingWithBundlerUnsupported(this.displayName);
    }

    this.assetHash = this.resolveAssetHash(this.displayName, props);
  }

  private resolveAssetHash(id: string, props: AssetStagingOptions): string {
    const { assetHash, assetHashType, extraHash } = props;

    if (assetHash !== undefined) {
      if (
        assetHashType !== undefined &&
        assetHashType !== AssetHashType.CUSTOM
      ) {
        throw assetHashConflictingHashType(id);
      }
      if (!SAFE_ASSET_HASH.test(assetHash)) {
        throw assetHashInvalid(id, assetHash);
      }
      return assetHash;
    }

    switch (assetHashType) {
      case AssetHashType.CUSTOM:
        throw assetHashTypeCustomRequiresHash(id);
      case AssetHashType.SOURCE:
      case AssetHashType.OUTPUT:
      case undefined: {
        const canonical = !!this.node.tryGetContext(CANONICAL_ASSET_HASHES);
        const archive = this.packaging.omitsDirectoryEntries;
        const salt = this.node.tryGetContext(ASSET_HASH_SALT_CONTEXT_KEY);

        // OUTPUT hashes the built artifact and so must build eagerly, forgoing
        // skippability (#380); every other case hashes the source verbatim.
        const baseHash =
          this.bundler && assetHashType === AssetHashType.OUTPUT
            ? this.hashOutput(canonical, archive)
            : this.hashSource(canonical, archive);

        // For SOURCE, folding in bundlerKey is the only way build identity
        // reaches the hash, since the source tree cannot see the build.
        const bundlerKey = this.bundler?.bundlerKey;
        if (!extraHash && !salt && !bundlerKey) {
          return baseHash;
        }
        const folded = crypto.createHash("md5").update(baseHash);
        if (extraHash) {
          folded.update(extraHash);
        }
        if (bundlerKey) {
          folded.update(bundlerKey);
        }
        if (salt) {
          folded.update(String(salt));
        }
        return folded.digest("hex").slice(0, 32).toUpperCase();
      }
      default:
        // Out-of-range value from a non-TypeScript caller.
        throw assetHashTypeUnknown(id, assetHashType);
    }
  }

  /**
   * Hash the source tree, honoring the ignore strategy.
   *
   * Cached per synth so an asset referenced more than once is walked once.
   */
  private hashSource(canonical: boolean, archive: boolean): string {
    // Only cacheable when the ignore strategy can summarize its behavior
    // as a string (see `IIgnoreStrategy.cacheKey`); otherwise every call
    // is treated as unique.
    const cacheKey =
      this.ignoreStrategy.cacheKey !== undefined
        ? JSON.stringify({
            sourcePath: this.sourcePath,
            canonical,
            archive,
            ignore: this.ignoreStrategy.cacheKey,
          })
        : undefined;

    const cached = cacheKey ? this.hashCache.get(cacheKey) : undefined;
    if (cached !== undefined) {
      return cached;
    }

    const hash = hashPath(this.sourcePath, {
      canonical,
      archive,
      shouldExclude: (relativePath, isDirectory) =>
        this.ignoreStrategy.ignores({ relativePath, isDirectory }),
      descendIntoExcludedDirectories:
        this.ignoreStrategy.pruneExcludedDirectories === false,
    });
    if (cacheKey) {
      this.hashCache.set(cacheKey, hash);
    }
    return hash;
  }

  /**
   * Build the bundler's output eagerly and hash the built artifact.
   *
   * The output is stashed for `stage()` to reuse, so the build is not
   * repeated. It is hashed verbatim: `exclude` filters the source a bundler
   * reads, not the artifact it produces.
   */
  private hashOutput(canonical: boolean, archive: boolean): string {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-bundle-"));
    // Registered so the exit sweep reclaims it if stage() never runs for an
    // unsynthesized stack; stage() removes and unregisters it otherwise.
    registerStrandedScratch(scratch);
    const produced = this.runBundle(scratch);
    this.eagerBuild = { scratch, produced };
    return hashPath(produced, { canonical, archive });
  }

  /**
   * Run the bundler against the filtered source and return its output.
   *
   * The bundler is handed an absolute `source` (its cwd is its own — docker
   * `-w`, esbuild — so a relative path would resolve elsewhere) that has
   * already had `exclude` applied. Materialising the filtered input here is
   * what makes the bundler read exactly the tree the hash was taken over: the
   * two would otherwise disagree, since `hashSource` honours `exclude` but a
   * raw source hand-off does not. The returned path is validated to be a
   * directory before packaging.
   *
   * @param scratch - caller-owned scratch directory to build within
   */
  private runBundle(scratch: string): string {
    const outputDir = path.join(scratch, "output");
    fs.mkdirSync(outputDir);
    const produced = this.bundler!.bundle({
      source: this.filteredSource(scratch),
      outputDir,
    });
    if (!fs.existsSync(produced) || !fs.statSync(produced).isDirectory()) {
      throw assetStagingBundlerOutputNotDirectory(this.displayName, produced);
    }
    return produced;
  }

  /**
   * Absolute path to the source the bundler should read.
   *
   * With no exclusions the resolved source is handed over directly. Otherwise
   * the excluded source tree is materialised into the scratch directory, so
   * the bundler sees the same file set the hash was taken over.
   *
   * @param scratch - caller-owned scratch directory to materialise into
   */
  private filteredSource(scratch: string): string {
    const absoluteSource = path.resolve(this.sourcePath);
    if (!this.hasExclusions) {
      return absoluteSource;
    }
    const input = path.join(scratch, "input");
    fs.mkdirSync(input);
    copySync(absoluteSource, input, {
      shouldExclude: (relativePath, isDirectory) =>
        this.ignoreStrategy.ignores({ relativePath, isDirectory }),
      descendIntoExcludedDirectories:
        this.ignoreStrategy.pruneExcludedDirectories === false,
    });
    return input;
  }

  /**
   * Stage the asset's content to `targetPath`.
   *
   * Called from the owning construct's `onSynthesize` hook. Without a bundler
   * the source is packaged verbatim; with one, the bundler's output is, built
   * eagerly for `OUTPUT` hashing or deferred to here for `SOURCE`.
   */
  public stage(targetPath: string): void {
    // Stage exactly once. An eager OUTPUT build is captured at construction
    // and consumed below; a second call would otherwise fall through to the
    // deferred path and rebuild, staging bytes a non-deterministic bundler
    // does not match its already-computed hash.
    if (this.staged) {
      throw assetStagingAlreadyStaged(this.displayName);
    }
    this.staged = true;

    if (!this.bundler) {
      this.packaging.pack({
        source: this.sourcePath,
        target: targetPath,
        ignoreStrategy: this.ignoreStrategy,
      });
      return;
    }

    // `OUTPUT` hashing already built the artifact in the constructor; package
    // that exact result and clean up its scratch, rather than building twice.
    if (this.eagerBuild) {
      const { scratch, produced } = this.eagerBuild;
      this.eagerBuild = undefined;
      try {
        this.packBundlerOutput(produced, targetPath);
      } finally {
        this.cleanupScratch(scratch);
      }
      return;
    }

    // `SOURCE` hashing defers the build to here.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-bundle-"));
    try {
      const produced = this.runBundle(scratch);
      this.packBundlerOutput(produced, targetPath);
    } finally {
      this.cleanupScratch(scratch);
    }
  }

  /**
   * Remove a bundler scratch directory and drop it from the exit-sweep set.
   */
  private cleanupScratch(scratch: string): void {
    fs.rmSync(scratch, { recursive: true, force: true });
    strandedScratchDirs.delete(scratch);
  }

  /**
   * Package a bundler's output into `targetPath`, verbatim.
   *
   * The ignore strategy is deliberately not applied. `exclude` filters the
   * source a bundler reads, not its product: an install-style bundler
   * (`npm install --production`, `pip install -t`) writes exactly the
   * dependency directory a user excludes from source, and re-applying the
   * exclusion would ship an artifact missing those dependencies.
   */
  private packBundlerOutput(produced: string, targetPath: string): void {
    this.packaging.pack({
      source: produced,
      target: targetPath,
    });
  }
}
