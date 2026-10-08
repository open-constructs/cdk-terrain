// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

import * as fs from "fs";
import * as path from "path";
import {
  chainBundlerAllDeclined,
  chainBundlerConflictingOutputFileName,
  chainBundlerRequiresAtLeastOneBundler,
} from "./errors";
import { archiveSync, copySync } from "./private/fs";
import { IIgnoreStrategy } from "./ignore-strategy";

/**
 * Common interface for all assets.
 */
export interface IAsset {
  /**
   * A hash of this asset, available at construction time.
   *
   * Being a plain string, it can be used in construct IDs to force a new
   * resource when the content hash changes.
   */
  readonly assetHash: string;
}

/**
 * Options controlling how an asset's hash is derived.
 */
export interface AssetOptions {
  /**
   * Specify a custom hash for this asset. If `assetHashType` is set it must
   * be set to `AssetHashType.CUSTOM`. The value is used verbatim as the asset
   * hash, and because it names the staged asset file it may only contain
   * letters, digits, `_`, `.` and `-`.
   *
   * The hash identifies a specific revision of the asset and caches deployment
   * work (packaging, uploading). A custom hash must be updated whenever the
   * asset changes, or some deployments will not be invalidated.
   *
   * @default - based on `assetHashType`
   */
  readonly assetHash?: string;

  /**
   * Specifies the type of hash to calculate for this asset.
   *
   * If `assetHash` is configured, this option must be `undefined` or
   * `AssetHashType.CUSTOM`.
   *
   * @default - the default is `AssetHashType.SOURCE`, but if `assetHash` is
   * explicitly specified this value defaults to `AssetHashType.CUSTOM`.
   */
  readonly assetHashType?: AssetHashType;

  /**
   * Digest algorithm used to compute the asset hash.
   *
   * `MD5` (the default) truncates to 32 uppercase hex characters, matching
   * every hash this library has ever produced. `SHA256` is kept full-length
   * and lowercase instead, matching the untruncated digest external tooling
   * (e.g. AWS CDK) expects when an asset hash must line up with one computed
   * elsewhere.
   *
   * Has no effect when `assetHashType` is `CUSTOM`, since `assetHash` is
   * then used verbatim.
   *
   * @default HashAlgorithm.MD5
   */
  readonly hashAlgorithm?: HashAlgorithm;
}

/**
 * Digest algorithm used to compute an asset hash.
 *
 * See `AssetOptions.hashAlgorithm`.
 */
export enum HashAlgorithm {
  /**
   * MD5, truncated to 32 uppercase hex characters.
   */
  MD5 = "md5",

  /**
   * SHA256, kept full-length and lowercase.
   */
  SHA256 = "sha256",
}

/**
 * The type of asset hash.
 *
 * The hash identifies a specific revision of the asset and caches deployment
 * work such as packaging and uploading.
 */
export enum AssetHashType {
  /**
   * Based on the content of the source path.
   *
   * Use `SOURCE` to track changes to the source files directly.
   */
  SOURCE = "source",

  /**
   * Based on the content of the bundling output.
   *
   * Use `OUTPUT` when the source is a top-level folder holding code and/or
   * dependencies not directly linked to the asset.
   */
  OUTPUT = "output",

  /**
   * Use a custom hash.
   */
  CUSTOM = "custom",
}

/**
 * How a staged asset is produced and what shape it takes on disk.
 *
 * Packaging answers two independent questions: how the artifact is produced
 * (copy, zip, tar.gz, ...) and whether the result is a directory or a single
 * file. A closed enum can only ever answer the second one, so it is an
 * interface rather than an enum — custom formats (e.g. `tar.bz2`) need no
 * core change.
 */
export interface IAssetPackaging {
  /**
   * Appended to the staged artifact name, e.g. ".zip", "", ".tar.bz2".
   */
  readonly extension: string;

  /**
   * Whether the staged result is a directory rather than a single file.
   *
   * Publishers branch on this to decide whether they upload one object or
   * sync a tree.
   */
  readonly producesDirectory: boolean;

  /**
   * Whether `pack` accepts a directory as its `source`.
   *
   * Independent of `producesDirectory` and `omitsDirectoryEntries`, both of
   * which describe the output: a `tar.gz` packaging takes a directory source
   * yet emits a single file. Bundler output is always a directory, so a
   * packaging that is `false` here cannot stage it.
   */
  readonly acceptsDirectorySource: boolean;

  /**
   * Whether `pack` emits an artifact with no directory entries of its own —
   * only the ignore-strategy-aware source walk. `hashPath`'s `archive` frame
   * must agree with this or the hash and the artifact describe different
   * file sets.
   *
   * `ZipPackaging` sets this because `archiveSync` never emits ZIP directory
   * entries. A directory-producing packaging that mirrors the source tree
   * (e.g. `DirectoryPackaging`) leaves this false, since its directories are
   * real entries on disk.
   */
  readonly omitsDirectoryEntries: boolean;

  /**
   * Write the packaged result to `options.target`.
   */
  pack(options: PackOptions): void;
}

/**
 * Options for {@link IAssetPackaging.pack}.
 *
 * A struct rather than positional parameters: adding a struct field is
 * additive, adding a method parameter is not, and `pack` is called through
 * JSII where that distinction is a breaking-change boundary.
 */
export interface PackOptions {
  /**
   * Path to the resolved (already bundled, if applicable) source.
   */
  readonly source: string;

  /**
   * Path the packaged result should be written to.
   */
  readonly target: string;

  /**
   * Entries to omit from the packaged result. Must match the strategy used
   * to hash the same source, or the hash and the artifact describe
   * different sets of files.
   *
   * @default - nothing is excluded
   */
  readonly ignoreStrategy?: IIgnoreStrategy;
}

/**
 * Copies a single file verbatim.
 */
class FilePackaging implements IAssetPackaging {
  public readonly extension = "";
  public readonly producesDirectory = false;
  public readonly acceptsDirectorySource = false;
  public readonly omitsDirectoryEntries = false;
  public pack(options: PackOptions): void {
    fs.copyFileSync(options.source, options.target);
  }
}

/**
 * Copies a directory tree verbatim, without archiving it.
 */
class DirectoryPackaging implements IAssetPackaging {
  public readonly extension = "";
  public readonly producesDirectory = true;
  public readonly acceptsDirectorySource = true;
  public readonly omitsDirectoryEntries = false;
  public pack(options: PackOptions): void {
    copySync(options.source, options.target, {
      shouldExclude: options.ignoreStrategy
        ? (relativePath, isDirectory) =>
            options.ignoreStrategy!.ignores({ relativePath, isDirectory })
        : undefined,
      descendIntoExcludedDirectories:
        options.ignoreStrategy?.pruneExcludedDirectories === false,
    });
  }
}

/**
 * Archives a directory tree into a single zip file.
 */
class ZipPackaging implements IAssetPackaging {
  public readonly extension = ".zip";
  public readonly producesDirectory = false;
  public readonly acceptsDirectorySource = true;
  public readonly omitsDirectoryEntries = true;
  public pack(options: PackOptions): void {
    archiveSync(
      options.source,
      options.target,
      options.ignoreStrategy
        ? (relativePath, isDirectory) =>
            options.ignoreStrategy!.ignores({ relativePath, isDirectory })
        : undefined,
      options.ignoreStrategy?.pruneExcludedDirectories === false,
    );
  }
}

/**
 * Built-in packaging strategies. Custom formats implement `IAssetPackaging`
 * directly rather than extending this class.
 */
export class AssetPackaging {
  /**
   * Copy a single file as-is.
   */
  public static readonly FILE: IAssetPackaging = new FilePackaging();

  /**
   * Copy a directory tree as-is, without archiving.
   */
  public static readonly DIRECTORY: IAssetPackaging = new DirectoryPackaging();

  /**
   * Archive a directory tree into a single zip file.
   */
  public static readonly ZIP: IAssetPackaging = new ZipPackaging();

  private constructor() {}
}

/**
 * Options handed to an {@link IAssetBundler} when it runs.
 *
 * A struct rather than positional parameters: adding a field is additive,
 * adding a method parameter is not, and `bundle` is called through JSII where
 * that distinction is a breaking-change boundary.
 */
export interface BundleOptions {
  /**
   * Absolute path to the asset's source file or directory. The bundler reads
   * from here and must not modify it.
   *
   * Exclusions (`exclude` / `ignoreStrategy`) are already applied: when any
   * are configured this points at a filtered copy, not the original tree, so
   * the bundler reads exactly the file set the asset hash was taken over.
   */
  readonly source: string;

  /**
   * A scratch directory the bundler may write into, owned and created by the
   * caller. The bundler produces its output here (or in a subdirectory) and
   * returns a {@link BundleResult} pointing at the finished artifact — see
   * {@link IAssetBundler.bundle}.
   */
  readonly outputDir: string;
}

/**
 * The shape of a bundler's output, so staging and packaging can treat a
 * single-file artifact (a tarball, a `.zip`) differently from a directory
 * tree without inferring it from the path.
 */
export enum BundleOutputType {
  /**
   * The output is a directory tree.
   *
   * Packaged like an unbundled source directory. The default, and the only
   * shape that predates archive support.
   */
  DIRECTORY = "directory",

  /**
   * The output is a single file the bundler already produced in its final
   * form.
   *
   * A tarball or a deterministic `.zip`. Staged verbatim rather than
   * re-archived, so `AssetType.FILE` no longer has to reject a bundler.
   */
  FILE = "file",
}

/**
 * What a bundler produced, returned from {@link IAssetBundler.bundle}.
 *
 * Carries the artifact path and its shape, or a declined state signalling the
 * caller should fall back. See {@link declined} for the decline protocol.
 */
export class BundleResult {
  /**
   * A directory-tree artifact at `path`.
   */
  public static directory(path: string): BundleResult {
    return new BundleResult(BundleOutputType.DIRECTORY, path, false);
  }

  /**
   * A single-file artifact at `path` (a tarball, a `.zip`), staged verbatim.
   */
  public static file(path: string): BundleResult {
    return new BundleResult(BundleOutputType.FILE, path, false);
  }

  /**
   * The bundler declined to run here; the caller should fall back.
   *
   * Distinct from a thrown error, which is a hard failure.
   */
  public static declined(): BundleResult {
    return new BundleResult(undefined, undefined, true);
  }

  /**
   * The artifact's shape, or undefined when {@link isDeclined}.
   */
  public readonly outputType?: BundleOutputType;

  /**
   * The artifact path, or undefined when {@link isDeclined}.
   */
  public readonly path?: string;

  /**
   * Whether the bundler declined to run, signalling the caller to fall back.
   */
  public readonly isDeclined: boolean;

  private constructor(
    outputType: BundleOutputType | undefined,
    path: string | undefined,
    isDeclined: boolean,
  ) {
    this.outputType = outputType;
    this.path = path;
    this.isDeclined = isDeclined;
  }
}

/**
 * Transforms a source tree into a built artifact. Runs at synth, before the
 * output is packaged and staged.
 *
 * This is the extension point for asset bundling: core ships no bundler.
 * Docker, esbuild, pip, `go build`, and similar are an open-ended, non
 * cloud-specific set, so each lives in its own package and implements this
 * one interface — the same way {@link IIgnoreStrategy} lets richer exclusion
 * live outside core. Users pass an instance via the consuming construct's
 * `bundler` option.
 *
 * `bundle` runs during the owning construct's `onSynthesize` hook and may
 * touch the filesystem. Deferring it there keeps it skippable when the asset's
 * stack is not being synthesized, which holds as long as the hash is taken
 * over the source rather than the built output.
 *
 * Bundlers compose through {@link ChainBundler} rather than a hierarchy: a
 * bundler declines (see {@link BundleResult.declined}) instead of failing when
 * it cannot run, and the chain falls through to the next.
 */
export interface IAssetBundler {
  /**
   * A value identifying the build, folded into the asset hash.
   *
   * The source tree alone cannot see the build, so swapping a `node:18` base
   * image for `node:20` would otherwise leave identity unchanged. Under
   * `SOURCE` hashing this is the only channel by which the build reaches
   * identity, so it must serialize every input that can move the output, or a
   * changed build silently reuses a stale artifact. {@link BundlerKey} builds
   * one from an ordered set of parts.
   *
   * Mirrors {@link IIgnoreStrategy.cacheKey}: omit it when the build cannot be
   * summarized as a string, and fall back to `extraHash`.
   *
   * @default - the build does not contribute to the hash
   */
  readonly bundlerKey?: string;

  /**
   * The name a single-file artifact is staged under (e.g. `archive.zip`).
   *
   * A file-producing bundler (`BundleResult.file`) staged with
   * `AssetType.FILE` would otherwise take the source path's basename, which is
   * a directory name when the source is a directory. Declaring the name here
   * lets the artifact reflect what the bundler produces. It is static
   * configuration, needed at construction before a deferred `SOURCE` build
   * runs, not the file's runtime name.
   *
   * Valid only for a file-producing bundler: setting it with a directory
   * packaging (anything but `AssetType.FILE`) is rejected at construction.
   *
   * @default - the source path's basename
   */
  readonly outputFileName?: string;

  /**
   * Produce the artifact and return a {@link BundleResult} describing it.
   *
   * Implementations write into `options.outputDir` and never write back to
   * `options.source`. The returned path must exist and match its declared
   * shape, or staging rejects it.
   *
   * A bundler that cannot run in this environment returns
   * `BundleResult.declined()` so a {@link ChainBundler} can fall through to
   * the next; a thrown error is a hard failure, not a decline.
   */
  bundle(options: BundleOptions): BundleResult;
}

/**
 * Builds an {@link IAssetBundler.bundlerKey} from an ordered set of parts.
 *
 * A `bundlerKey` has to serialize everything that can move a build's output;
 * done ad hoc, every bundler invents its own delimiter and forgets an input
 * differently. This gives the convention one implementation: parts are joined
 * with a separator that is escaped inside values, so distinct inputs cannot
 * collide into the same key.
 *
 * @example
 * const key = BundlerKey.of("docker", image, command)
 *   .withEnv({ NODE_ENV: nodeEnv })
 *   .toString();
 */
export class BundlerKey {
  /**
   * Start a key from an ordered list of parts.
   *
   * Order is significant: it is part of what the key identifies.
   */
  public static of(...parts: string[]): BundlerKey {
    return new BundlerKey(parts);
  }

  private static escape(part: string): string {
    return part.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  }

  private constructor(private readonly parts: string[]) {}

  /**
   * Append parts, returning a new key.
   */
  public add(...parts: string[]): BundlerKey {
    return new BundlerKey([...this.parts, ...parts]);
  }

  /**
   * Append `key=value` parts for a record, sorted by key so the result does
   * not depend on property order.
   */
  public withEnv(entries: Record<string, string>): BundlerKey {
    const kept = Object.keys(entries)
      .sort()
      .map((k) => `${k}=${entries[k]}`);
    return new BundlerKey([...this.parts, ...kept]);
  }

  /**
   * Render the collected parts to the string passed as `bundlerKey`.
   */
  public toString(): string {
    return this.parts.map(BundlerKey.escape).join(":");
  }
}

/**
 * Composes bundlers into a "try each in order until one runs" chain.
 *
 * This is how a local bundler and a Docker bundler compose without being
 * rewritten as one: each leg declines (`BundleResult.declined()`) when it
 * cannot run here, and the chain moves to the next. The first non-declining
 * result wins; if all decline, `bundle` throws, since staging has nothing to
 * fall back to. Each leg builds into its own output directory, so a leg that
 * writes before declining cannot leak partial files into the leg that wins.
 *
 * The chain's `bundlerKey` folds in *every* leg's key, so identity is the same
 * regardless of which leg ends up running — a build that could have gone local
 * or Docker is one asset, not two.
 *
 * This makes the legs interchangeable only if they produce equivalent output.
 * Under `SOURCE` hashing they must: a machine with a host tool and one without
 * run different legs, and non-equivalent legs would stage different bytes under
 * the same hash. Use `OUTPUT` hashing when legs may diverge, so identity tracks
 * the artifact each leg actually produced.
 */
export class ChainBundler implements IAssetBundler {
  /**
   * Chain bundlers in the order given; earlier bundlers are preferred.
   */
  public static of(...bundlers: IAssetBundler[]): ChainBundler {
    return new ChainBundler(bundlers);
  }

  public readonly bundlerKey?: string;

  public readonly outputFileName?: string;

  private constructor(private readonly bundlers: IAssetBundler[]) {
    if (bundlers.length === 0) {
      throw chainBundlerRequiresAtLeastOneBundler();
    }
    // Fold in every leg's key so which leg runs cannot change identity. A leg
    // without a key contributes an empty part, still distinguishing "two legs"
    // from "one leg" positionally.
    const keys = bundlers.map((b) => b.bundlerKey ?? "");
    this.bundlerKey = keys.some((k) => k !== "")
      ? BundlerKey.of("chain", ...keys).toString()
      : undefined;

    // The staged file name is fixed at construction, before any leg runs, so
    // legs that declare one must agree — otherwise the name would depend on
    // which leg happens to run.
    const names = new Set(
      bundlers
        .map((b) => b.outputFileName)
        .filter((n): n is string => n !== undefined),
    );
    if (names.size > 1) {
      throw chainBundlerConflictingOutputFileName([...names]);
    }
    this.outputFileName = names.size === 1 ? [...names][0] : undefined;
  }

  public bundle(options: BundleOptions): BundleResult {
    for (let i = 0; i < this.bundlers.length; i++) {
      // Each leg gets its own output directory. A leg is free to write before
      // it declines (esbuild failing on an unsupported target, a Docker leg
      // creating output before finding the daemon down), and sharing one
      // directory would leak those partial files into the leg that succeeds.
      const legOutputDir = path.join(options.outputDir, `leg-${i}`);
      fs.mkdirSync(legOutputDir);
      const result = this.bundlers[i].bundle({
        source: options.source,
        outputDir: legOutputDir,
      });
      if (!result.isDeclined) {
        return result;
      }
    }
    throw chainBundlerAllDeclined(this.bundlers.length);
  }
}

/**
 * A staged artifact, ready to hand to an `IAssetPublisher`.
 *
 * Deliberately narrower than a location: `path` and `isDirectory` are known
 * once staging runs, at synth time, before anything is published. Where an
 * asset ends up — a bucket name, an object key, a URL — is resolved at
 * apply time and belongs on the publisher's own reference type instead.
 */
export interface StagedAsset {
  /**
   * A hash on the content source, uniquely identifying this asset.
   *
   * The asset is not rebuilt or republished while this value is unchanged.
   */
  readonly assetHash: string;

  /**
   * The path to the staged artifact, relative to the stack directory.
   */
  readonly path: string;

  /**
   * Whether the staged artifact is a directory rather than a single file.
   *
   * Publishers branch on this to decide whether they upload one object or
   * sync a tree; see `IAssetPackaging.producesDirectory`.
   */
  readonly isDirectory: boolean;
}
