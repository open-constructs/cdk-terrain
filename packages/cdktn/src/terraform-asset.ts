// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";
import {
  AssetPackaging,
  AssetHashType,
  IAsset,
  IAssetBundler,
  IAssetPackaging,
} from "./assets";
import { AssetStaging } from "./asset-staging";
import { findFileAboveCwd } from "./private/fs";
import { ISynthesisSession } from "./synthesize";
import { addCustomSynthesis } from "./synthesize/synthesizer";
import { TerraformStack } from "./terraform-stack";
import {
  assetExpectsDirectory,
  assetOutOfScopeOfCDKTFJson,
  assetTypeNotImplemented,
} from "./errors";

export interface TerraformAssetConfig {
  // path to the file or folder configured. If relative, the path is resolved from the location of cdktf.json
  readonly path: string;
  // file type of the asset, either AssetType.FILE, AssetType.DIRECTORY, AssetType.ARCHIVE
  readonly type?: AssetType;
  // hash value of the asset, if passed will be used as returned assetHash
  readonly assetHash?: string;
  /**
   * How the `assetHash` is derived.
   *
   * `SOURCE` (the default) hashes the source path. `CUSTOM` uses the
   * `assetHash` value verbatim and requires it to be set. `OUTPUT` hashes the
   * source too, unless a `bundler` is set — then it hashes the bundler's
   * built output, which forces an eager build (see `bundler`).
   *
   * If `assetHash` is set, this must be `undefined` or `AssetHashType.CUSTOM`.
   *
   * @default AssetHashType.SOURCE
   */
  readonly assetHashType?: AssetHashType;

  /**
   * Paths to exclude from the asset, relative to `path`. See
   * `AssetStagingOptions.exclude` for the accepted forms. Both the computed
   * hash and the staged/packed content honor the exclusion.
   *
   * @default - nothing is excluded
   */
  readonly exclude?: string[];

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
   * Core ships no bundler; implement `IAssetBundler` or use one from a bundler
   * package. Under the default `SOURCE` hashing the build is deferred to synth
   * and stays skippable; `OUTPUT` hashing builds eagerly to hash the artifact.
   * `AssetType.FILE` is rejected, since bundler output is always a directory.
   * See `AssetStagingOptions.bundler`.
   *
   * @default - the source is staged verbatim, with no build step
   */
  readonly bundler?: IAssetBundler;
}

export enum AssetType {
  FILE,
  DIRECTORY,
  ARCHIVE,
}

// Base name for a packaged (non-directory, non-verbatim-file) artifact. The
// packaging's `extension` is appended, so a zip stays `archive.zip` and a
// future `tar.bz2` packaging would be `archive.tar.bz2` with no change here.
const ARCHIVE_BASENAME = "archive";
const ASSETS_DIRECTORY = "assets";

/**
 * How each `AssetType` is actually written to disk at synthesis time.
 * Internal wiring only: swapping this map's values is how a future format
 * would be added, without any change to the public `AssetType` surface.
 */
const PACKAGING_BY_TYPE: Record<AssetType, IAssetPackaging> = {
  [AssetType.FILE]: AssetPackaging.FILE,
  [AssetType.DIRECTORY]: AssetPackaging.DIRECTORY,
  [AssetType.ARCHIVE]: AssetPackaging.ZIP,
};

// eslint-disable-next-line jsdoc/require-jsdoc
export class TerraformAsset extends Construct implements IAsset {
  private stack: TerraformStack;
  private sourcePath: string;
  // hash value of the asset that can be passed to consuming constructs (e.g. to not recreate a lambda function in case the underlying files did not change)
  public readonly assetHash: string;
  // file type of the asset, either AssetType.FILE, AssetType.DIRECTORY, AssetType.ARCHIVE
  public type: AssetType;
  // owns hashing and packing; `AssetStaging` also validates a custom `assetHash`
  private readonly staging: AssetStaging;

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

    const stat = fs.statSync(this.sourcePath);
    const inferredType = stat.isFile() ? AssetType.FILE : AssetType.DIRECTORY;
    this.type = config.type ?? inferredType;

    // Validate the type against the source before staging, so an invalid
    // combination is rejected here rather than after AssetStaging has already
    // run an eager bundler build.
    if (stat.isFile() !== (this.type === AssetType.FILE)) {
      throw assetExpectsDirectory(id, config.path);
    }

    this.staging = new AssetStaging(this, "Staging", {
      sourcePath: this.sourcePath,
      packaging: this.packaging,
      assetHash: config.assetHash,
      assetHashType: config.assetHashType,
      exclude: config.exclude,
      extraHash: config.extraHash,
      bundler: config.bundler,
    });
    this.assetHash = this.staging.assetHash;

    addCustomSynthesis(this, {
      onSynthesize: this._onSynthesize.bind(this),
    });
  }

  private get namedFolder(): string {
    return path.posix.join(
      ASSETS_DIRECTORY,
      this.stack.getLogicalId(this.node),
    );
  }

  /**
   * How this asset is written to disk. The layout (directory vs single file)
   * and the artifact name are derived from this rather than from `type`
   * directly, so the two never disagree.
   */
  private get packaging(): IAssetPackaging {
    const packaging = PACKAGING_BY_TYPE[this.type];
    if (!packaging) {
      throw assetTypeNotImplemented();
    }
    return packaging;
  }

  /**
   * The path relative to the root of the terraform directory in posix format
   * Use this property to reference the asset
   */
  public get path(): string {
    return path.posix.join(
      this.namedFolder, // readable name
      this.assetHash, // hash depending on content so that path changes if content changes
      // A directory-producing packaging has no file segment; anything else
      // contributes its artifact name.
      this.packaging.producesDirectory ? "" : this.fileName,
    );
  }

  /**
   * Name of the asset
   */
  public get fileName(): string {
    const { extension } = this.packaging;
    // Repackaged artifacts (extension set) get a stable base + extension;
    // verbatim copies keep the source name.
    return extension
      ? `${ARCHIVE_BASENAME}${extension}`
      : path.basename(this.sourcePath);
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
    const packaging = this.packaging;

    if (packaging.producesDirectory) {
      fs.mkdirSync(targetPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    }

    this.staging.stage(targetPath);
  }
}
