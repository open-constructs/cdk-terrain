// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
// Simplified from AWS CDK and TerraConstructs patterns

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Construct } from "constructs";
import { AssetHashType, AssetOptions, FileAssetPackaging } from "./assets";
import {
  BundlingFileAccess,
  BundlingOptions,
  BundlingOutput,
} from "./bundling";
import {
  assetHashInvalid,
  bundlingOutputEmpty,
  bundlingOutputNotArchived,
  bundlingOutputNotSingleFile,
} from "./errors";
import { CANONICAL_ASSET_HASHES } from "./features";
import {
  AssetBundlingBindMount,
  AssetBundlingVolumeCopy,
} from "./private/asset-staging";
import {
  copySync,
  excludeMatcher,
  hashPath as fsHashPath,
  type ExcludePredicate,
} from "./private/fs";

/**
 * Context key mixing an extra value into every asset hash in the tree. Intended
 * for forcing global cache invalidation; composes with `extraHash` rather than
 * replacing it.
 */
const ASSET_SALT_CONTEXT_KEY = "cdktn:assetHashSalt";

/**
 * A custom `assetHash` becomes a path segment of the staged file, so it is
 * restricted to characters that cannot escape the staging directory.
 */
const SAFE_ASSET_HASH = /^[A-Za-z0-9_.-]+$/;

/**
 * Bundling is expensive and its result is fully determined by the source and
 * the staging options, so identical assets within one synth reuse the first
 * staged result instead of running the container again.
 */
const stagingCache = new Map<string, StagedAsset>();

/**
 * How an asset is packaged, together with the path that should be staged.
 */
interface ResolvedPackaging {
  readonly packaging: FileAssetPackaging;
  readonly isArchive: boolean;
  readonly finalSourcePath: string;
}

/**
 * The outcome of staging, cached so repeated identical assets skip bundling.
 */
interface StagedAsset extends ResolvedPackaging {
  readonly assetHash: string;
  readonly absoluteStagedPath: string;
}

/**
 * Initialization properties for `AssetStaging`.
 */
export interface AssetStagingProps extends AssetOptions {
  /**
   * The source file or directory to copy from. A relative path is resolved
   * against the current working directory, not against `cdktf.json`.
   */
  readonly sourcePath: string;

  /**
   * Paths to exclude, relative to `sourcePath` and always `/`-separated. Each
   * entry may be an exact file path, a `*.ext` suffix match, or a directory
   * (with or without a trailing `/`), which also excludes everything inside it.
   *
   * This is not full glob syntax: `**`, `?`, character classes and `!`
   * negation are not supported.
   *
   * @default - nothing is excluded
   */
  readonly exclude?: string[];

  /**
   * Extra information to encode into the fingerprint.
   *
   * @default - no extra data
   */
  readonly extraHash?: string;

  /**
   * Bundle the asset by executing a command in a Docker container.
   *
   * The asset path will be mounted at `/asset-input`. The Docker
   * container is responsible for putting content at `/asset-output`.
   * The content at `/asset-output` will be used as the final asset.
   *
   * @default - uploaded as-is
   */
  readonly bundling?: BundlingOptions;
}

/**
 * Stages a file or directory from a location on the file system into a staging
 * directory.
 *
 * This follows AWS CDK and TerraConstructs patterns but keeps implementation simple.
 * Features can be added gradually as needed.
 *
 * The file/directory are staged based on their content hash (fingerprint). This
 * means that only if content was changed, copy will happen.
 */
export class AssetStaging extends Construct {
  /**
   * The path in the container where the asset source will be mounted.
   */
  public static readonly BUNDLING_INPUT_DIR = "/asset-input";

  /**
   * The path in the container where the bundled output should be written.
   */
  public static readonly BUNDLING_OUTPUT_DIR = "/asset-output";

  /**
   * Absolute path to the asset data after staging.
   */
  public readonly absoluteStagedPath: string;

  /**
   * The absolute path of the asset as it was referenced by the user.
   */
  public readonly sourcePath: string;

  /**
   * A cryptographic hash of the asset.
   */
  public readonly assetHash: string;

  /**
   * How this asset should be packaged.
   */
  public readonly packaging: FileAssetPackaging;

  /**
   * Whether this asset is an archive (zip or jar).
   */
  public readonly isArchive: boolean;

  private readonly assetOutdir: string;
  private readonly sourceStats: fs.Stats;
  private readonly shouldExclude: ExcludePredicate;

  constructor(scope: Construct, id: string, props: AssetStagingProps) {
    super(scope, id);

    this.sourcePath = path.resolve(props.sourcePath);

    if (!fs.existsSync(this.sourcePath)) {
      throw new Error(`Cannot find asset at ${this.sourcePath}`);
    }

    this.sourceStats = fs.statSync(this.sourcePath);
    this.shouldExclude = excludeMatcher(props.exclude ?? []);
    this.assetOutdir = this.determineAssetOutdir();

    const hashType = this.determineHashType(props);

    // Every input that can change the staged result must be in the key,
    // including the context values that feed the hash.
    const cacheKey = JSON.stringify({
      outdir: this.assetOutdir,
      sourcePath: this.sourcePath,
      hashType,
      assetHash: props.assetHash,
      extraHash: props.extraHash,
      exclude: props.exclude,
      bundling: props.bundling,
      canonical: !!this.node.tryGetContext(CANONICAL_ASSET_HASHES),
      salt: this.node.tryGetContext(ASSET_SALT_CONTEXT_KEY),
    });
    const cached = stagingCache.get(cacheKey);
    if (cached && fs.existsSync(cached.absoluteStagedPath)) {
      this.assetHash = cached.assetHash;
      this.packaging = cached.packaging;
      this.isArchive = cached.isArchive;
      this.absoluteStagedPath = cached.absoluteStagedPath;
      return;
    }

    // Bundling must happen before packaging is resolved, because the shape of
    // the bundling output is what decides it.
    let finalSourcePath = this.sourcePath;
    let scratchDir: string | undefined;
    if (props.bundling) {
      if (!this.sourceStats.isDirectory()) {
        throw new Error("Asset must be a directory when bundling");
      }
      // Scratch lives in the system temp dir, never in assetOutdir, so a crash
      // cannot leave non-asset entries in the output tree.
      scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-bundle-"));
      finalSourcePath = this.bundle(props, scratchDir);
    }

    try {
      const bundlingOutputType =
        props.bundling?.outputType ?? BundlingOutput.AUTO_DISCOVER;

      // Packaging must resolve before hashing: it selects the archive framing
      // of the hash, and it narrows finalSourcePath to the actual output file,
      // which sets the staged extension.
      const resolved = this.resolvePackaging(
        props,
        finalSourcePath,
        bundlingOutputType,
      );
      this.packaging = resolved.packaging;
      this.isArchive = resolved.isArchive;
      finalSourcePath = resolved.finalSourcePath;

      this.assetHash = this.calculateHash(hashType, props, finalSourcePath);

      const extension = this.getExtension(finalSourcePath);
      this.absoluteStagedPath = path.resolve(
        this.assetOutdir,
        `asset.${this.assetHash}${extension}`,
      );

      this.copyAsset(finalSourcePath, this.absoluteStagedPath);

      stagingCache.set(cacheKey, {
        assetHash: this.assetHash,
        packaging: this.packaging,
        isArchive: this.isArchive,
        absoluteStagedPath: this.absoluteStagedPath,
        finalSourcePath,
      });
    } finally {
      if (scratchDir) {
        fs.rmSync(scratchDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Resolve where staged assets are written. The app's own outdir wins so that
   * concurrent synths of different apps cannot collide; the `cdktf.json` walk
   * remains as a fallback for trees built without an `App`.
   */
  private determineAssetOutdir(): string {
    const app = this.node.root;
    if ("outdir" in app && typeof (app as any).outdir === "string") {
      return path.join((app as any).outdir, "assets");
    }

    const cdktfJsonPath = this.findCdktfJson();
    if (cdktfJsonPath) {
      return path.join(path.dirname(cdktfJsonPath), "cdktf.out", "assets");
    }

    return path.join("cdktf.out", "assets");
  }

  /**
   * Run the bundler into `bundleDir`, preferring a local bundler when it
   * reports that it handled the asset.
   * @returns the directory holding the bundling output
   */
  private bundle(props: AssetStagingProps, bundleDir: string): string {
    if (props.bundling!.local?.tryBundle(bundleDir, props.bundling!)) {
      return bundleDir;
    }

    process.stdout.write(`Bundling asset ${this.node.path}...\n`);

    const fileAccess =
      props.bundling!.bundlingFileAccess ?? BundlingFileAccess.BIND_MOUNT;
    const bundlingProps = {
      ...props.bundling!,
      sourcePath: this.sourcePath,
      bundleDir,
      scope: this,
    };

    if (fileAccess === BundlingFileAccess.VOLUME_COPY) {
      new AssetBundlingVolumeCopy(bundlingProps).run();
    } else {
      new AssetBundlingBindMount(bundlingProps).run();
    }

    return bundleDir;
  }

  /**
   * Decide how the asset is packaged, validating the bundling output against
   * the requested {@link BundlingOutput}.
   * @returns the resolved packaging plus the path to stage, narrowed to a
   * single file where applicable
   */
  private resolvePackaging(
    props: AssetStagingProps,
    sourcePath: string,
    bundlingOutputType: BundlingOutput,
  ): ResolvedPackaging {
    let packaging: FileAssetPackaging;
    let isArchive: boolean;
    let finalSourcePath = sourcePath;
    if (props.bundling) {
      const bundledStat = fs.statSync(finalSourcePath);

      if (bundledStat.isDirectory()) {
        const files = fs.readdirSync(finalSourcePath);

        // Validate empty output
        if (files.length === 0) {
          throw bundlingOutputEmpty(this.node.path, finalSourcePath);
        }

        if (files.length === 1) {
          const singleFile = path.join(finalSourcePath, files[0]);
          const singleStat = fs.statSync(singleFile);

          if (
            singleStat.isFile() &&
            this.isArchiveExtension(path.extname(files[0]))
          ) {
            // Single archive file found
            if (bundlingOutputType === BundlingOutput.SINGLE_FILE) {
              // SINGLE_FILE expects non-archive, but got archive - this is invalid
              throw bundlingOutputNotSingleFile(
                this.node.path,
                finalSourcePath,
                files.length,
                files,
              );
            }

            // Valid for AUTO_DISCOVER, ARCHIVED, NOT_ARCHIVED
            if (
              bundlingOutputType === BundlingOutput.AUTO_DISCOVER ||
              bundlingOutputType === BundlingOutput.ARCHIVED
            ) {
              packaging = FileAssetPackaging.FILE;
              isArchive = true;
              finalSourcePath = singleFile;
            } else {
              // NOT_ARCHIVED: treat as directory to zip
              packaging = FileAssetPackaging.ZIP_DIRECTORY;
              isArchive = false;
            }
          } else if (singleStat.isFile()) {
            // Single non-archive file found
            if (bundlingOutputType === BundlingOutput.ARCHIVED) {
              // ARCHIVED expects an archive, but got non-archive
              throw bundlingOutputNotArchived(
                this.node.path,
                finalSourcePath,
                files.length,
                files,
              );
            }

            if (bundlingOutputType === BundlingOutput.SINGLE_FILE) {
              packaging = FileAssetPackaging.FILE;
              isArchive = false;
              finalSourcePath = singleFile;
            } else {
              // AUTO_DISCOVER or NOT_ARCHIVED: zip it
              packaging = FileAssetPackaging.ZIP_DIRECTORY;
              isArchive = false;
            }
          } else {
            // Single directory or other non-file - always zip
            packaging = FileAssetPackaging.ZIP_DIRECTORY;
            isArchive = false;
          }
        } else {
          // Multiple files
          if (bundlingOutputType === BundlingOutput.ARCHIVED) {
            throw bundlingOutputNotArchived(
              this.node.path,
              finalSourcePath,
              files.length,
              files,
            );
          }

          if (bundlingOutputType === BundlingOutput.SINGLE_FILE) {
            throw bundlingOutputNotSingleFile(
              this.node.path,
              finalSourcePath,
              files.length,
              files,
            );
          }

          // AUTO_DISCOVER or NOT_ARCHIVED: zip everything
          packaging = FileAssetPackaging.ZIP_DIRECTORY;
          isArchive = false;
        }
      } else {
        // Single file output (bundling directly produced a file, not a directory)
        packaging = FileAssetPackaging.FILE;
        isArchive = this.isArchiveExtension(this.getExtension(finalSourcePath));
      }
    } else {
      // No bundling - simple case
      if (this.sourceStats.isDirectory()) {
        packaging = FileAssetPackaging.ZIP_DIRECTORY;
        isArchive = true;
      } else {
        packaging = FileAssetPackaging.FILE;
        isArchive = this.isArchiveExtension(this.getExtension(finalSourcePath));
      }
    }

    return { packaging, isArchive, finalSourcePath };
  }

  private findCdktfJson(): string | null {
    const contextPath = this.node.tryGetContext("cdktfJsonPath");
    if (contextPath) return contextPath;

    let dir = process.cwd();
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, "cdktf.json");
      if (fs.existsSync(candidate)) return candidate;
      dir = path.dirname(dir);
    }
    return null;
  }

  private determineHashType(props: AssetStagingProps): AssetHashType {
    const customHash = props.assetHash;
    const hashType = customHash
      ? (props.assetHashType ?? AssetHashType.CUSTOM)
      : (props.assetHashType ?? AssetHashType.SOURCE);

    if (customHash && hashType !== AssetHashType.CUSTOM) {
      throw new Error(
        `Cannot specify assetHashType when assetHash is provided. Use CUSTOM or leave undefined.`,
      );
    }

    if (hashType === AssetHashType.CUSTOM && !customHash) {
      throw new Error(
        "assetHash must be specified when assetHashType is CUSTOM.",
      );
    }

    return hashType;
  }

  private calculateHash(
    hashType: AssetHashType,
    props: AssetStagingProps,
    sourcePath?: string,
  ): string {
    if (hashType === AssetHashType.CUSTOM) {
      // Used verbatim (matching TerraformAsset), so it must be safe as a path
      // segment of the staged file name.
      if (!SAFE_ASSET_HASH.test(props.assetHash!)) {
        throw assetHashInvalid(this.node.path, props.assetHash!);
      }
      return props.assetHash!;
    }

    // SOURCE hashes the original tree; OUTPUT hashes the bundling result.
    const pathToHash =
      hashType === AssetHashType.SOURCE
        ? this.sourcePath
        : sourcePath || this.sourcePath;

    const baseHash = fsHashPath(pathToHash, {
      canonical: !!this.node.tryGetContext(CANONICAL_ASSET_HASHES),
      archive: this.packaging === FileAssetPackaging.ZIP_DIRECTORY,
      // OUTPUT hashes the already-filtered bundling output, so re-applying the
      // source exclusions there would be wrong.
      shouldExclude:
        hashType === AssetHashType.SOURCE ? this.shouldExclude : undefined,
    });

    const salt = this.node.tryGetContext(ASSET_SALT_CONTEXT_KEY);
    if (!salt && !props.extraHash) {
      return baseHash;
    }

    // Both fold into the digest: a salt must not mask an extraHash bump.
    const combined = crypto.createHash("md5").update(baseHash);
    if (props.extraHash) combined.update(props.extraHash);
    if (salt) combined.update(salt);
    return combined.digest("hex").slice(0, 32).toUpperCase();
  }

  /**
   * Copy the resolved source into the staging directory. Skipped when the
   * target already exists, since the path is content-keyed.
   */
  private copyAsset(source: string, target: string) {
    if (fs.existsSync(target)) return;

    fs.mkdirSync(path.dirname(target), { recursive: true });

    // lstat, not stat: a symlinked source file must be staged as a file rather
    // than crashing when the link dangles.
    const stat = fs.lstatSync(source);

    if (stat.isDirectory()) {
      copySync(source, target, { shouldExclude: this.shouldExclude });
    } else if (stat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), target);
    } else {
      fs.copyFileSync(source, target);
    }
  }

  private getExtension(filePath: string): string {
    const archiveExtensions = [".tar.gz", ".zip", ".jar", ".tar", ".tgz"];

    for (const ext of archiveExtensions) {
      if (filePath.toLowerCase().endsWith(ext)) {
        return ext;
      }
    }

    return path.extname(filePath);
  }

  private isArchiveExtension(ext: string): boolean {
    const archiveExtensions = [".tar.gz", ".zip", ".jar", ".tar", ".tgz"];
    return archiveExtensions.includes(ext.toLowerCase());
  }
}
