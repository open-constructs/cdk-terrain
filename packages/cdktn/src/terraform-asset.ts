// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";
import {
  copySync,
  archiveSync,
  hashPath,
  findFileAboveCwd,
} from "./private/fs";
import { CANONICAL_ASSET_HASHES } from "./features";
import { ISynthesisSession } from "./synthesize";
import { addCustomSynthesis } from "./synthesize/synthesizer";
import { TerraformStack } from "./terraform-stack";
import {
  assetExpectsDirectory,
  assetOutOfScopeOfCDKTFJson,
  assetTypeNotImplemented,
} from "./errors";
import { type AssetHashType, FileAssetPackaging } from "./assets";
import { AssetStaging } from "./asset-staging";
import { type BundlingOptions } from "./bundling";

export interface TerraformAssetConfig {
  // path to the file or folder configured. If relative, the path is resolved from the location of cdktf.json
  readonly path: string;
  // file type of the asset, either AssetType.FILE, AssetType.DIRECTORY, AssetType.ARCHIVE
  readonly type?: AssetType;
  // hash value of the asset, if passed will be used as returned assetHash
  readonly assetHash?: string;

  /**
   * Paths to exclude from the asset, relative to `path` and always
   * `/`-separated. Each entry may be an exact file path, a `*.ext` suffix
   * match, or a directory (with or without a trailing `/`), which also excludes
   * everything inside it.
   *
   * This is not full glob syntax: `**`, `?`, character classes and `!`
   * negation are not supported.
   *
   * @default - nothing is excluded
   */
  readonly exclude?: string[];

  /**
   * Extra information to encode into the fingerprint (e.g. build instructions
   * and other inputs).
   *
   * @default - no extra hash
   */
  readonly extraHash?: string;

  /**
   * Bundle the asset by executing a command in a Docker container or a
   * custom bundling provider.
   *
   * The asset path will be mounted at `/asset-input`. The Docker
   * container is responsible for putting content at `/asset-output`.
   * The content at `/asset-output` will be zipped and used as the
   * final asset.
   *
   * @default - uploaded as-is to the stack location without bundling
   */
  readonly bundling?: BundlingOptions;

  /**
   * Specify a custom hash for this asset. If `assetHashType` is set it must
   * be set to `AssetHashType.CUSTOM`. The value is used verbatim as the asset
   * hash, and because it names the staged asset file it may only contain
   * letters, digits, `_`, `.` and `-`.
   *
   * NOTE: the hash is used in order to identify a specific revision of the asset, and
   * used for optimizing and caching deployment activities related to this asset such as
   * packaging, uploading to a container registry, etc. If you chose to customize the hash, you will
   * need to make sure it is updated every time the asset changes, or otherwise it is
   * possible that some deployments will not be invalidated.
   *
   * @default - based on `assetHashType`
   */
  readonly assetHashType?: AssetHashType;
}

export enum AssetType {
  FILE,
  DIRECTORY,
  ARCHIVE,
}

const ARCHIVE_NAME = "archive.zip";
const ASSETS_DIRECTORY = "assets";

// eslint-disable-next-line jsdoc/require-jsdoc
export class TerraformAsset extends Construct {
  private stack: TerraformStack;
  private sourcePath: string;
  // hash value of the asset that can be passed to consuming constructs (e.g. to not recreate a lambda function in case the underlying files did not change)
  public assetHash: string;
  // file type of the asset, either AssetType.FILE, AssetType.DIRECTORY, AssetType.ARCHIVE
  public type: AssetType;

  /**
   * Internal staging helper for advanced features (bundling, exclusions, etc.)
   * @private
   */
  private staging?: AssetStaging;

  /**
   * A Terraform Asset takes a file or directory outside of the CDK Terrain context and moves it into it.
   * Assets copy referenced files into the stacks context for further usage in other resources.
   * @param scope
   * @param id
   * @param config
   */
  constructor(scope: Construct, id: string, config: TerraformAssetConfig) {
    super(scope, id);

    this.stack = TerraformStack.of(this);

    // Resolve source path (relative to cdktf.json if relative, absolute otherwise)
    if (path.isAbsolute(config.path)) {
      this.sourcePath = config.path;
    } else {
      const cdktfJsonPath =
        scope.node.tryGetContext("cdktfJsonPath") ??
        findFileAboveCwd("cdktf.json");
      if (cdktfJsonPath) {
        // Relative paths are always considered to be relative to cdktf.json, but operations are performed relative to process.cwd
        const absolutePath = path.resolve(
          path.dirname(cdktfJsonPath),
          config.path,
        );
        this.sourcePath = path.relative(process.cwd(), absolutePath);
      } else {
        throw assetOutOfScopeOfCDKTFJson(id, config.path);
      }
    }

    // Check if advanced features are requested
    const useAdvancedStaging = !!(
      config.exclude ||
      config.extraHash ||
      config.bundling ||
      config.assetHashType
    );

    if (useAdvancedStaging) {
      // Use AssetStaging for advanced features (bundling, exclusions, etc.)
      this.staging = new AssetStaging(this, "__staging__", {
        sourcePath: this.sourcePath,
        exclude: config.exclude,
        extraHash: config.extraHash,
        bundling: config.bundling,
        assetHash: config.assetHash,
        assetHashType: config.assetHashType,
      });

      this.assetHash = this.staging.assetHash;

      // Map AssetStaging packaging to TerraformAsset type
      if (this.staging.packaging === FileAssetPackaging.FILE) {
        this.type = this.staging.isArchive ? AssetType.ARCHIVE : AssetType.FILE;
      } else {
        // ZIP_DIRECTORY
        this.type = AssetType.ARCHIVE;
      }

      // Override with explicit type if provided
      if (config.type !== undefined) {
        this.validateType(id, config.path, config.type);
        this.type = config.type;
      }
    } else {
      // Use existing simple implementation (BACKWARDS COMPATIBLE)
      const stat = fs.statSync(this.sourcePath);
      const inferredType = stat.isFile() ? AssetType.FILE : AssetType.DIRECTORY;
      this.type = config.type ?? inferredType;
      this.assetHash =
        config.assetHash ||
        hashPath(this.sourcePath, {
          canonical: !!this.node.tryGetContext(CANONICAL_ASSET_HASHES),
          archive: this.type === AssetType.ARCHIVE,
        });

      // Validation
      if (stat.isFile() && this.type !== AssetType.FILE) {
        throw assetExpectsDirectory(id, config.path);
      }

      if (!stat.isFile() && this.type === AssetType.FILE) {
        throw assetExpectsDirectory(id, config.path);
      }
    }

    addCustomSynthesis(this, {
      onSynthesize: this._onSynthesize.bind(this),
    });
  }

  /**
   * Reject a `type` that the staged asset cannot satisfy, matching the
   * validation the non-staged path performs. A directory (or anything staged as
   * a zip) can never be emitted as `AssetType.FILE`, and a single staged file
   * can never be emitted as `AssetType.DIRECTORY`.
   */
  private validateType(id: string, configPath: string, type: AssetType) {
    const stagedAsDirectory =
      this.staging!.packaging === FileAssetPackaging.ZIP_DIRECTORY;

    if (stagedAsDirectory && type === AssetType.FILE) {
      throw assetExpectsDirectory(id, configPath);
    }

    if (!stagedAsDirectory && type === AssetType.DIRECTORY) {
      throw assetExpectsDirectory(id, configPath);
    }
  }

  private get namedFolder(): string {
    return path.posix.join(
      ASSETS_DIRECTORY,
      this.stack.getLogicalId(this.node),
    );
  }

  /**
   * The path relative to the root of the terraform directory in posix format
   * Use this property to reference the asset
   */
  public get path(): string {
    return path.posix.join(
      this.namedFolder, // readable name
      this.assetHash, // hash depending on content so that path changes if content changes
      this.type === AssetType.DIRECTORY ? "" : this.fileName,
    );
  }

  /**
   * Name of the asset
   */
  public get fileName(): string {
    switch (this.type) {
      case AssetType.ARCHIVE:
        return ARCHIVE_NAME;
      default:
        return path.basename(this.sourcePath);
    }
  }

  private _onSynthesize(session: ISynthesisSession) {
    const stackManifest = session.manifest.forStack(this.stack);
    const basePath = path.join(
      session.manifest.outdir,
      stackManifest.synthesizedStackPath,
      "..",
    );

    // Cleanup existing assets
    const previousVersionsFolder = path.join(basePath, this.namedFolder);
    if (fs.existsSync(previousVersionsFolder)) {
      fs.rmSync(previousVersionsFolder, { recursive: true });
    }

    const targetPath = path.join(basePath, this.path);

    if (this.type === AssetType.DIRECTORY) {
      fs.mkdirSync(targetPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    }

    // Use staged asset if available (from advanced features), otherwise use source
    const sourceToUse = this.staging?.absoluteStagedPath ?? this.sourcePath;

    switch (this.type) {
      case AssetType.FILE:
        fs.copyFileSync(sourceToUse, targetPath);
        break;

      case AssetType.DIRECTORY:
        copySync(sourceToUse, targetPath);
        break;

      case AssetType.ARCHIVE:
        // A staged single file is copied as-is; only a directory can be zipped.
        if (
          this.staging &&
          this.staging.packaging === FileAssetPackaging.FILE
        ) {
          fs.copyFileSync(sourceToUse, targetPath);
        } else {
          archiveSync(sourceToUse, targetPath);
        }
        break;
      default:
        throw assetTypeNotImplemented();
    }
  }
}
