// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as crypto from "crypto";
import * as path from "path";
import { hashPath, findFileAboveCwd } from "./private/fs";
import { ExcludeIgnoreStrategy, IIgnoreStrategy } from "./ignore-strategy";
import {
  assetHashConflictingExcludeOptions,
  assetHashOutOfScopeCdktnJson,
} from "./errors";

/**
 * Options for {@link AssetHash.of}.
 */
export interface AssetHashOptions {
  /**
   * Paths to exclude, relative to the hashed path. Cannot be combined with
   * `ignoreStrategy`, which replaces this matcher rather than layering on
   * top of it.
   *
   * @default - nothing is excluded
   */
  readonly exclude?: string[];

  /**
   * Extra information to fold into the hash.
   *
   * @default - no extra data
   */
  readonly extraHash?: string;

  /**
   * Exclusion matching, for callers that need `.gitignore` / `.dockerignore`
   * parity rather than the built-in exact-path / suffix / directory matcher.
   *
   * @default - `exclude` is used with the built-in matcher
   */
  readonly ignoreStrategy?: IIgnoreStrategy;
}

/**
 * Computes a content hash of a file or directory without staging it.
 *
 * Providers that read a local path directly — a Docker build `context`, for
 * example — need a content hash to drive `triggers`, but have no use for a
 * staged copy of the source. `Asset` and `TerraformAsset` always produce a
 * staged copy; this is the identity half without the staging half.
 */
export class AssetHash {
  /**
   * Content hash of a file or directory, without staging it.
   *
   * This is a hash of the source tree, and it does not depend on how the
   * source is later packaged. `hashPath` is always called with `archive`
   * unset, so directory records are part of the digest; the hash of a given
   * tree is therefore the same whether it is later copied, zipped, or packed
   * by a custom `IAssetPackaging` such as `tar.bz2`.
   *
   * A consequence worth stating: this does not equal
   * `TerraformAsset(dir, { type: ARCHIVE }).assetHash` for a directory with
   * subdirectories. That asset frames its hash to the emitted ZIP, which has
   * no directory entries (see #323), so directory-only changes move it and
   * not this. It equals a `FILE` / `DIRECTORY` `TerraformAsset` hash only
   * when the `canonicalAssetHashes` flag is enabled, since that flag is what
   * puts the asset on this same canonical scheme.
   *
   * A relative `filePath` is resolved against the directory containing
   * `cdktf.json`, the same base `TerraformAsset` uses, so both hash the same
   * source regardless of the process working directory. Absolute paths are
   * used as-is. Throws if `filePath` is relative and no `cdktf.json` is found
   * above the working directory.
   * @param filePath - path to a file or directory to hash
   * @param options - see {@link AssetHashOptions}
   */
  public static of(filePath: string, options: AssetHashOptions = {}): string {
    if (options.exclude?.length && options.ignoreStrategy) {
      throw assetHashConflictingExcludeOptions();
    }

    const resolved = AssetHash.resolvePath(filePath);
    const strategy =
      options.ignoreStrategy ??
      new ExcludeIgnoreStrategy(options.exclude ?? []);

    // Pinned to the canonical scheme: this is a brand-new API with no
    // existing hashes to preserve, so it has no reason to start on the
    // legacy scheme that `canonicalAssetHashes` exists to move away from.
    const baseHash = hashPath(resolved, {
      canonical: true,
      shouldExclude: (relativePath, isDirectory) =>
        strategy.ignores({ relativePath, isDirectory }),
      descendIntoExcludedDirectories:
        strategy.pruneExcludedDirectories === false,
    });

    if (!options.extraHash) {
      return baseHash;
    }

    return crypto
      .createHash("md5")
      .update(baseHash)
      .update(options.extraHash)
      .digest("hex")
      .slice(0, 32)
      .toUpperCase();
  }

  /**
   * Resolve `filePath` to an absolute path using the same base as
   * `TerraformAsset`: relative paths are anchored to the directory holding
   * `cdktf.json`, not `process.cwd()`, so a hash taken here matches the one
   * `TerraformAsset` computes for the same source even when the app is run
   * from a subdirectory or a test runner. Unlike `TerraformAsset`, there is
   * no construct scope to read the `cdktfJsonPath` context from, so this uses
   * the `findFileAboveCwd` fallback directly.
   * @param filePath - path passed to {@link AssetHash.of}
   */
  private static resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    const cdktfJsonPath = findFileAboveCwd("cdktf.json");
    if (!cdktfJsonPath) {
      throw assetHashOutOfScopeCdktnJson(filePath);
    }
    return path.resolve(path.dirname(cdktfJsonPath), filePath);
  }

  private constructor() {}
}
