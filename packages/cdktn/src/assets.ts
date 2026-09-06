// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

import * as fs from "fs";
import { archiveSync, copySync } from "./private/fs";
import { IIgnoreStrategy } from "./ignore-strategy";

/**
 * Common interface for all assets.
 */
export interface IAsset {
  /**
   * A hash of this asset, which is available at construction time. As this is a plain string, it
   * can be used in construct IDs in order to enforce creation of a new resource when the content
   * hash has changed.
   */
  readonly assetHash: string;
}

/**
 * Asset hash options
 */
export interface AssetOptions {
  /**
   * Specify a custom hash for this asset. If `assetHashType` is set it must
   * be set to `AssetHashType.CUSTOM`. The value is used verbatim as the asset
   * hash, and because it names the staged asset file it may only contain
   * letters, digits, `_`, `.` and `-`.
   *
   * NOTE: the hash is used in order to identify a specific revision of the asset, and
   * used for optimizing and caching deployment activities related to this asset such as
   * packaging, uploading to cloud storage, etc. If you chose to customize the hash, you will
   * need to make sure it is updated every time the asset changes, or otherwise it is
   * possible that some deployments will not be invalidated.
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
}

/**
 * The type of asset hash
 *
 * NOTE: the hash is used in order to identify a specific revision of the asset, and
 * used for optimizing and caching deployment activities related to this asset such as
 * packaging, uploading to cloud storage, etc.
 */
export enum AssetHashType {
  /**
   * Based on the content of the source path
   *
   * Use `SOURCE` when the content of the asset changes frequently or when
   * you want to track changes to the source files directly.
   */
  SOURCE = "source",

  /**
   * Based on the content of the bundling output
   *
   * Use `OUTPUT` when the source of the asset is a top level folder containing
   * code and/or dependencies that are not directly linked to the asset.
   */
  OUTPUT = "output",

  /**
   * Use a custom hash
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
   * Perform the staging transformation, writing the packaged result to
   * `options.target`.
   * @param options - see {@link PackOptions}
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
  public pack(options: PackOptions): void {
    copySync(options.source, options.target, {
      shouldExclude: options.ignoreStrategy
        ? (relativePath) => options.ignoreStrategy!.ignores(relativePath)
        : undefined,
    });
  }
}

/**
 * Archives a directory tree into a single zip file.
 */
class ZipPackaging implements IAssetPackaging {
  public readonly extension = ".zip";
  public readonly producesDirectory = false;
  public pack(options: PackOptions): void {
    archiveSync(
      options.source,
      options.target,
      options.ignoreStrategy
        ? (relativePath) => options.ignoreStrategy!.ignores(relativePath)
        : undefined,
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
 * A staged artifact, ready to hand to an `IAssetPublisher`.
 *
 * Deliberately narrower than a location: `path` and `isDirectory` are known
 * once staging runs, at synth time, before anything is published. Where an
 * asset ends up — a bucket name, an object key, a URL — is resolved at
 * apply time and belongs on the publisher's own reference type instead.
 */
export interface StagedAsset {
  /**
   * A hash on the content source. This hash is used to uniquely identify this
   * asset throughout the system. If this value doesn't change, the asset will
   * not be rebuilt or republished.
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
