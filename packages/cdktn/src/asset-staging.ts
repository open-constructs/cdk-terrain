// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct, IConstruct } from "constructs";
import * as crypto from "crypto";
import { AssetHashType, AssetOptions, IAsset, IAssetPackaging } from "./assets";
import {
  assetHashConflictingExcludeOptions,
  assetHashConflictingHashType,
  assetHashInvalid,
  assetHashTypeCustomRequiresHash,
  assetHashTypeUnknown,
} from "./errors";
import { CANONICAL_ASSET_HASHES } from "./features";
import { ExcludeIgnoreStrategy, IIgnoreStrategy } from "./ignore-strategy";
import { hashPath } from "./private/fs";

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
}

/**
 * Resolves an asset's identity (`SOURCE`/`OUTPUT`/`CUSTOM` hashing, with
 * `exclude`/`extraHash`) and stages it to disk.
 *
 * Hashing happens eagerly in the constructor; staging the content to
 * `targetPath` only happens when `stage()` is called, which callers do from
 * their own `onSynthesize` hook. This keeps the filesystem side effect in the
 * one window where it is safe to run, and keeps this class skippable once a
 * bundler is introduced.
 *
 * `SOURCE` and `OUTPUT` compute identically here: without a bundler, the
 * "output" of an asset is its source verbatim. A future bundler changes what
 * `OUTPUT` hashes, not this class.
 *
 * The source-tree walk behind `SOURCE`/`OUTPUT` is cached per synth (see
 * {@link hashCachesByRoot}), so referencing the same asset from more than one
 * resource or stack hashes it once. `ASSET_HASH_SALT_CONTEXT_KEY` folds an
 * app-wide value into every computed hash, for bulk cache-busting across an
 * entire tree rather than one asset's `extraHash`.
 */
export class AssetStaging extends Construct implements IAsset {
  private readonly sourcePath: string;
  private readonly ignoreStrategy: IIgnoreStrategy;
  private readonly hashCache: Map<string, string>;

  public readonly packaging: IAssetPackaging;
  public readonly isDirectory: boolean;
  public readonly assetHash: string;

  public constructor(scope: Construct, id: string, props: AssetStagingOptions) {
    super(scope, id);

    this.sourcePath = props.sourcePath;
    this.packaging = props.packaging;
    this.isDirectory = props.packaging.producesDirectory;
    this.hashCache = hashCacheFor(this.node.root);

    if (props.exclude?.length && props.ignoreStrategy) {
      throw assetHashConflictingExcludeOptions();
    }
    this.ignoreStrategy =
      props.ignoreStrategy ?? new ExcludeIgnoreStrategy(props.exclude ?? []);

    this.assetHash = this.resolveAssetHash(id, props);
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

        let baseHash = cacheKey ? this.hashCache.get(cacheKey) : undefined;
        if (baseHash === undefined) {
          baseHash = hashPath(this.sourcePath, {
            canonical,
            archive,
            shouldExclude: (relativePath, isDirectory) =>
              this.ignoreStrategy.ignores({ relativePath, isDirectory }),
            descendIntoExcludedDirectories:
              this.ignoreStrategy.pruneExcludedDirectories === false,
          });
          if (cacheKey) {
            this.hashCache.set(cacheKey, baseHash);
          }
        }

        if (!extraHash && !salt) {
          return baseHash;
        }
        const folded = crypto.createHash("md5").update(baseHash);
        if (extraHash) {
          folded.update(extraHash);
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
   * Write the staged content to `targetPath`. Called from the owning
   * construct's `onSynthesize` hook, once the target path is known.
   * @param targetPath - path the packaged result should be written to
   */
  public stage(targetPath: string): void {
    this.packaging.pack({
      source: this.sourcePath,
      target: targetPath,
      ignoreStrategy: this.ignoreStrategy,
    });
  }
}
