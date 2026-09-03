// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

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
 * Represents the source for a file asset.
 */
export interface FileAssetSource {
  /**
   * A hash on the content source. This hash is used to uniquely identify this
   * asset throughout the system. If this value doesn't change, the asset will
   * not be rebuilt or republished.
   */
  readonly sourceHash: string;

  /**
   * The path, relative to the root of the cloud assembly, in which this asset
   * source resides. This can be a path to a file or a directory, depending on the
   * packaging type.
   */
  readonly fileName: string;

  /**
   * Which type of packaging to perform.
   *
   * @default - Required if `fileName` is specified.
   */
  readonly packaging?: FileAssetPackaging;

  /**
   * Whether or not the asset needs to exist beyond deployment time; i.e.
   * are copied over to a different location and not needed afterwards.
   * Setting this property to true has an impact on the lifecycle of the asset,
   * because we will assume that it is safe to delete after the Terraform
   * deployment succeeds.
   *
   * For example, Lambda Function assets or Azure Function assets are copied
   * over during deployment. Therefore, it is not necessary to store the asset
   * in cloud storage permanently, so we consider those deployTime assets.
   *
   * @default false
   */
  readonly deployTime?: boolean;

  /**
   * A display name for this asset
   *
   * If supplied, the display name will be used in locations where the asset
   * identifier is printed, like in the CLI progress information.
   *
   * @default - The asset hash is used to display the asset
   */
  readonly displayName?: string;
}

/**
 * Represents the source for a Docker image asset.
 */
export interface DockerImageAssetSource {
  /**
   * The hash of the contents of the docker build context. This hash is used
   * throughout the system to identify this image and avoid duplicate work
   * in case the source did not change.
   *
   * NOTE: this means that if you wish to update your docker image, you
   * must make a modification to the source (e.g. add some metadata to your Dockerfile).
   */
  readonly sourceHash: string;

  /**
   * The directory where the Dockerfile is stored, must be relative
   * to the cloud assembly root.
   */
  readonly directoryName: string;

  /**
   * Build args to pass to the `docker build` command.
   *
   * Since Docker build arguments are resolved before deployment, keys and
   * values cannot refer to unresolved tokens (such as `resource.id` or
   * `resource.arn`).
   *
   * Only allowed when `directoryName` is specified.
   *
   * @default - no build args are passed
   */
  readonly dockerBuildArgs?: { [key: string]: string };

  /**
   * Build contexts to pass to the `docker build` command.
   *
   * Build contexts can be used to specify additional directories or images
   * to use during the build. Each entry specifies a named build context
   * and its source (a directory path, a URL, or a docker image).
   *
   * Only allowed when `directoryName` is specified.
   *
   * @see https://docs.docker.com/build/building/context/#additional-build-contexts
   *
   * @default - no additional build contexts
   */
  readonly dockerBuildContexts?: { [key: string]: string };

  /**
   * Build secrets to pass to the `docker build` command.
   *
   * Since Docker build secrets are resolved before deployment, keys and
   * values cannot refer to unresolved tokens (such as `resource.id` or
   * `resource.arn`).
   *
   * Only allowed when `directoryName` is specified.
   *
   * @default - no build secrets are passed
   */
  readonly dockerBuildSecrets?: { [key: string]: string };

  /**
   * SSH agent socket or keys to pass to the `docker buildx` command.
   *
   * @default - no ssh arg is passed
   */
  readonly dockerBuildSsh?: string;

  /**
   * Docker target to build to
   *
   * Only allowed when `directoryName` is specified.
   *
   * @default - no target
   */
  readonly dockerBuildTarget?: string;

  /**
   * Path to the Dockerfile (relative to the directory).
   *
   * Only allowed when `directoryName` is specified.
   *
   * @default - Dockerfile
   */
  readonly dockerFile?: string;

  /**
   * Networking mode for the RUN commands during build. _Requires Docker Engine API v1.25+_.
   *
   * Specify this property to build images on a specific networking mode.
   *
   * @default - no networking mode specified
   */
  readonly networkMode?: string;

  /**
   * Platform to build for. _Requires Docker Buildx_.
   *
   * Specify this property to build images on a specific platform.
   *
   * @default - no platform specified (the current machine architecture will be used)
   */
  readonly platform?: string;

  /**
   * Outputs to pass to the `docker build` command.
   *
   * @default - no outputs are passed
   */
  readonly dockerOutputs?: string[];

  /**
   * Unique identifier of the docker image asset and its potential revisions.
   *
   * @default - no asset name
   */
  readonly assetName?: string;

  /**
   * Cache from options to pass to the `docker build` command.
   *
   * @default - no cache from args are passed
   */
  readonly dockerCacheFrom?: DockerCacheOption[];

  /**
   * Cache to options to pass to the `docker build` command.
   *
   * @default - no cache to args are passed
   */
  readonly dockerCacheTo?: DockerCacheOption;

  /**
   * Disable the cache and pass `--no-cache` to the `docker build` command.
   *
   * @default - cache is used
   */
  readonly dockerCacheDisabled?: boolean;

  /**
   * A display name for this asset
   *
   * If supplied, the display name will be used in locations where the asset
   * identifier is printed, like in the CLI progress information.
   *
   * @default - The asset hash is used to display the asset
   */
  readonly displayName?: string;
}

/**
 * Packaging modes for file assets.
 */
export enum FileAssetPackaging {
  /**
   * The asset source path points to a directory, which should be archived using
   * zip and then uploaded to cloud storage (e.g. S3, Azure Blob Storage, GCS).
   */
  ZIP_DIRECTORY = "zip",

  /**
   * The asset source path points to a single file, which should be uploaded
   * to cloud storage (e.g. S3, Azure Blob Storage, GCS).
   */
  FILE = "file",
}

/**
 * Generic location of a published file asset.
 *
 * This interface provides a cloud-agnostic representation of where an asset
 * is stored. Specific cloud provider implementations should extend this interface
 * with provider-specific properties (e.g., S3-specific, Azure-specific, GCS-specific).
 */
export interface FileAssetLocation {
  /**
   * The name of the storage bucket/container.
   *
   * - AWS: S3 bucket name
   * - Azure: Storage account container name
   * - GCP: GCS bucket name
   */
  readonly bucketName: string;

  /**
   * The object key/path within the bucket.
   *
   * - AWS: S3 object key
   * - Azure: Blob name
   * - GCP: Object name
   */
  readonly objectKey: string;

  /**
   * The HTTP/HTTPS URL of this asset.
   *
   * This value is suitable for inclusion in a Terraform configuration, and
   * may be an encoded token.
   *
   * Example values:
   * - AWS: `https://s3-us-east-1.amazonaws.com/mybucket/myobject`
   * - Azure: `https://mystorageaccount.blob.core.windows.net/mycontainer/myblob`
   * - GCP: `https://storage.googleapis.com/mybucket/myobject`
   */
  readonly httpUrl: string;

  /**
   * The protocol-specific URL of this asset.
   *
   * This value is suitable for inclusion in a Terraform configuration, and
   * may be an encoded token.
   *
   * Example values:
   * - AWS: `s3://mybucket/myobject`
   * - Azure: `az://mycontainer/myblob`
   * - GCP: `gs://mybucket/myobject`
   */
  readonly objectUrl: string;

  /**
   * Like `objectUrl`, but not suitable for Terraform consumption.
   *
   * If there are placeholders in the URL, they will be returned un-replaced
   * and un-evaluated.
   *
   * @default - This feature cannot be used
   */
  readonly objectUrlWithPlaceholders?: string;
}

/**
 * Generic location of a published docker image.
 *
 * This interface provides a cloud-agnostic representation of where a Docker image
 * is stored. Specific cloud provider implementations should extend this interface
 * with provider-specific properties (e.g., ECR-specific, ACR-specific, GCR-specific).
 */
export interface DockerImageAssetLocation {
  /**
   * The URI of the image (including a tag).
   *
   * Example values:
   * - AWS ECR: `123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:tag`
   * - Azure ACR: `myregistry.azurecr.io/my-repo:tag`
   * - GCP GCR: `gcr.io/my-project/my-repo:tag`
   * - GCP Artifact Registry: `us-docker.pkg.dev/my-project/my-repo/my-image:tag`
   */
  readonly imageUri: string;

  /**
   * The name of the repository.
   *
   * - AWS: ECR repository name
   * - Azure: ACR repository name
   * - GCP: GCR/Artifact Registry repository name
   */
  readonly repositoryName: string;

  /**
   * The tag of the image.
   *
   * @default - the hash of the asset
   */
  readonly imageTag?: string;
}

/**
 * Options for configuring the Docker cache backend
 */
export interface DockerCacheOption {
  /**
   * The type of cache to use.
   * Refer to https://docs.docker.com/build/cache/backends/ for full list of backends.
   *
   * @default - unspecified
   * @example 'registry'
   */
  readonly type: string;

  /**
   * Any parameters to pass into the docker cache backend configuration.
   * Refer to https://docs.docker.com/build/cache/backends/ for cache backend configuration.
   *
   * @default {} No options provided
   * @example
   * const params = {
   *   ref: `myregistry.azurecr.io/cache:branch`,
   *   mode: "max",
   * };
   */
  readonly params?: { [key: string]: string };
}
