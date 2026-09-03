// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
// Simplified Docker bundling - following AWS CDK patterns

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { dockerExec } from "./private/asset-staging";

/**
 * Bundling options for Docker-based builds
 */
export interface BundlingOptions {
  /**
   * The Docker image where the command will run.
   *
   * @example DockerImage.fromRegistry('node:18-alpine')
   * @example DockerImage.fromRegistry('public.ecr.aws/lambda/python:3.11')
   * @example DockerImage.fromBuild('./docker')
   */
  readonly image: DockerImage;

  /**
   * The command to run in the Docker container.
   *
   * @example ['npm', 'run', 'build']
   * @default - run the command defined in the image
   */
  readonly command?: string[];

  /**
   * The entrypoint to run in the Docker container.
   *
   * @example ['/bin/sh', '-c']
   * @default - run the entrypoint defined in the image
   */
  readonly entrypoint?: string[];

  /**
   * Environment variables to pass to the Docker container.
   *
   * @default - no environment variables
   */
  readonly environment?: { [key: string]: string };

  /**
   * Working directory inside the Docker container.
   *
   * @default /asset-input
   */
  readonly workingDirectory?: string;

  /**
   * The user to use when running the Docker container.
   *
   * @example '1000:1000'
   * @default - root
   */
  readonly user?: string;

  /**
   * Networking mode for the Docker container.
   *
   * @default - bridge
   */
  readonly network?: string;

  /**
   * Platform to build for (requires Docker Buildx).
   *
   * @example 'linux/amd64'
   * @default - no platform specified
   */
  readonly platform?: string;

  /**
   * Security options for the container.
   *
   * @example 'no-new-privileges'
   * @default - none
   */
  readonly securityOpt?: string;

  /**
   * Additional Docker volumes to mount.
   *
   * @default - no additional volumes
   */
  readonly volumes?: DockerVolume[];

  /**
   * Mount volumes from other containers.
   *
   * @default - no volumes from other containers
   */
  readonly volumesFrom?: string[];

  /**
   * The type of output that this bundling operation is producing.
   *
   * @default BundlingOutput.AUTO_DISCOVER
   */
  readonly outputType?: BundlingOutput;

  /**
   * The access mechanism used to make source files available to the bundling
   * container and to return the bundling output back to the host.
   *
   * BIND_MOUNT mounts the source and output directories directly into the container.
   * This is faster and simpler, but requires the Docker daemon to have access to the
   * host filesystem.
   *
   * VOLUME_COPY creates temporary Docker volumes and containers to copy files to/from
   * the bundling container. This is slower, but works in more complex situations
   * (e.g., remote or shared Docker sockets, Docker-in-Docker, etc.).
   *
   * @default BundlingFileAccess.BIND_MOUNT
   */
  readonly bundlingFileAccess?: BundlingFileAccess;

  /**
   * Local bundling provider.
   *
   * If provided, this will be tried first before Docker bundling.
   * If it returns true, Docker bundling will be skipped.
   *
   * @default - no local bundling
   */
  readonly local?: ILocalBundling;
}

/**
 * The type of output that a bundling operation is producing.
 */
export enum BundlingOutput {
  /**
   * The bundling output directory includes a single archive file (zip or jar).
   * If the output directory does not include exactly a single archive, bundling will fail.
   */
  ARCHIVED = "archived",

  /**
   * The bundling output directory contains one or more files which will be
   * archived and uploaded as a .zip file.
   */
  NOT_ARCHIVED = "not-archived",

  /**
   * If the bundling output directory contains a single archive file (zip or jar)
   * it will be used as-is. Otherwise, all files will be zipped.
   */
  AUTO_DISCOVER = "auto-discover",

  /**
   * The bundling output directory includes a single file.
   * Similar to ARCHIVED but for non-archive files.
   */
  SINGLE_FILE = "single-file",
}

/**
 * The access mechanism used to make source files available to the bundling
 * container and to return the bundling output back to the host.
 */
export enum BundlingFileAccess {
  /**
   * Creates temporary volumes and containers to copy files from the host to
   * the bundling container and back. This is slower, but works also in more
   * complex situations with remote or shared docker sockets.
   */
  VOLUME_COPY = "VOLUME_COPY",

  /**
   * The source and output folders will be mounted as bind mount from the host
   * system. This is faster and simpler, but less portable than `VOLUME_COPY`.
   */
  BIND_MOUNT = "BIND_MOUNT",
}

/**
 * Local bundling interface
 */
export interface ILocalBundling {
  /**
   * Try to bundle locally.
   *
   * @param outputDir the directory where the bundled asset should be output
   * @param options bundling options for this asset
   * @returns true if local bundling was performed, false otherwise
   */
  tryBundle(outputDir: string, options: BundlingOptions): boolean;
}

/**
 * A Docker volume mount configuration
 */
export interface DockerVolume {
  /**
   * Path on the host machine
   */
  readonly hostPath: string;

  /**
   * Path in the container
   */
  readonly containerPath: string;

  /**
   * Mount consistency. This is a macOS-only performance hint and is ignored by
   * Docker on other platforms.
   *
   * @default - no consistency option is passed
   */
  readonly consistency?: DockerVolumeConsistency;

  /**
   * Mount the volume as read-only
   * @default false
   */
  readonly readOnly?: boolean;
}

/**
 * Docker volume consistency types (macOS optimization)
 */
export enum DockerVolumeConsistency {
  /**
   * Full consistency - slowest, most consistent
   */
  CONSISTENT = "consistent",

  /**
   * Delegated consistency - fast, eventual consistency
   */
  DELEGATED = "delegated",

  /**
   * Cached consistency - read-optimized
   */
  CACHED = "cached",
}

/**
 * Options for running a Docker container
 */
export interface DockerRunOptions {
  /**
   * Container entrypoint override
   */
  readonly entrypoint?: string[];

  /**
   * Command to run in container
   */
  readonly command?: string[];

  /**
   * Volume mounts
   */
  readonly volumes?: DockerVolume[];

  /**
   * Mount volumes from other containers
   */
  readonly volumesFrom?: string[];

  /**
   * Environment variables
   */
  readonly environment?: Record<string, string>;

  /**
   * Working directory in container
   */
  readonly workingDirectory?: string;

  /**
   * User to run as (uid:gid)
   */
  readonly user?: string;

  /**
   * Security options
   */
  readonly securityOpt?: string;

  /**
   * Network mode
   */
  readonly network?: string;

  /**
   * Platform (e.g., linux/amd64)
   */
  readonly platform?: string;
}

/**
 * Options for building a Docker image
 */
export interface DockerBuildOptions {
  /**
   * Build arguments
   */
  readonly buildArgs?: Record<string, string>;

  /**
   * Dockerfile name (relative to context)
   * @default Dockerfile
   */
  readonly file?: string;

  /**
   * Platform to build for
   */
  readonly platform?: string;

  /**
   * Build target stage
   */
  readonly targetStage?: string;

  /**
   * Disable build cache
   * @default false
   */
  readonly cacheDisabled?: boolean;
}

/**
 * A Docker image reference for bundling operations
 */
export class DockerImage {
  /**
   * Reference an image from a registry
   *
   * @param image Image name (e.g., "node:18", "public.ecr.aws/lambda/python:3.11")
   */
  public static fromRegistry(image: string): DockerImage {
    return new DockerImage(image);
  }

  /**
   * Build an image from a Dockerfile.
   *
   * Note that this runs `docker build` eagerly, matching AWS CDK: merely
   * describing an image performs the build.
   *
   * @param contextPath Path to directory containing Dockerfile
   * @param options Build options
   */
  public static fromBuild(
    contextPath: string,
    options: DockerBuildOptions = {},
  ): DockerImage {
    if (options.file && path.isAbsolute(options.file)) {
      throw new Error(
        `Dockerfile path must be relative to context. Got: ${options.file}`,
      );
    }

    // Validate that the Dockerfile stays within the context path
    if (options.file) {
      const resolvedContext = path.resolve(contextPath);
      const resolvedDockerfile = path.resolve(contextPath, options.file);
      if (
        !resolvedDockerfile.startsWith(resolvedContext + path.sep) &&
        resolvedDockerfile !== resolvedContext
      ) {
        throw new Error(
          `Dockerfile must be within the build context. Context: ${contextPath}, Dockerfile: ${options.file}`,
        );
      }
    }

    // Stable tag derived from the build inputs' identity, not their contents:
    // editing the Dockerfile reuses the tag. Do not feed this into an asset
    // hash without also hashing the build context.
    const input = JSON.stringify({ path: contextPath, ...options });
    const hash = crypto.createHash("sha256").update(input).digest("hex");
    const tag = `cdktn-${hash}`;

    // Build the image
    const buildArgs: string[] = [
      "build",
      "-t",
      tag,
      ...(options.file ? ["-f", path.join(contextPath, options.file)] : []),
      ...(options.platform ? ["--platform", options.platform] : []),
      ...(options.targetStage ? ["--target", options.targetStage] : []),
      ...(options.cacheDisabled ? ["--no-cache"] : []),
      ...Object.entries(options.buildArgs || {}).flatMap(([k, v]) => [
        "--build-arg",
        `${k}=${v}`,
      ]),
      contextPath,
    ];

    dockerExec(buildArgs);

    return new DockerImage(tag, hash);
  }

  constructor(
    /**
     * The image name/tag
     */
    public readonly image: string,
    /**
     * Optional stable hash for the image
     */
    private readonly _hash?: string,
  ) {}

  /**
   * Run a command in this Docker image
   *
   * @param options Run options
   */
  public run(options: DockerRunOptions = {}): void {
    const args = [
      "run",
      "--rm",
      ...(options.securityOpt ? ["--security-opt", options.securityOpt] : []),
      ...(options.network ? ["--network", options.network] : []),
      ...(options.platform ? ["--platform", options.platform] : []),
      ...(options.user ? ["-u", options.user] : []),
      ...(options.volumesFrom?.flatMap((v) => ["--volumes-from", v]) || []),
      ...(options.volumes?.flatMap((v) => {
        // `consistency` is a macOS-only hint, so it is only emitted when asked
        // for; `ro` is meaningful everywhere.
        const mode = [v.consistency, v.readOnly ? "ro" : undefined]
          .filter(Boolean)
          .join(",");
        return [
          "-v",
          `${v.hostPath}:${v.containerPath}${mode ? `:${mode}` : ""}`,
        ];
      }) || []),
      ...(Object.entries(options.environment || {}).flatMap(([k, v]) => [
        "--env",
        `${k}=${v}`,
      ]) || []),
      ...(options.workingDirectory ? ["-w", options.workingDirectory] : []),
      ...(options.entrypoint ? ["--entrypoint", options.entrypoint[0]] : []),
      this.image,
      ...(options.entrypoint ? options.entrypoint.slice(1) : []),
      ...(options.command || []),
    ];

    dockerExec(args);
  }

  /**
   * Copy a file or directory from the image to the host
   *
   * @param imagePath Path in the image
   * @param outputPath Path on host (creates temp dir if not specified)
   * @returns The output path
   */
  public cp(imagePath: string, outputPath?: string): string {
    // Create temporary container
    const result = dockerExec(["create", this.image], { stdio: "pipe" });
    const containerId = result.stdout.toString().trim();

    if (!containerId) {
      throw new Error("Failed to create temporary container");
    }

    try {
      // Determine output path
      const destPath = outputPath || this.createTempDir();

      // Copy files from container
      dockerExec(["cp", `${containerId}:${imagePath}`, destPath]);

      return destPath;
    } finally {
      // Clean up container
      dockerExec(["rm", "-v", containerId]);
    }
  }

  /**
   * Get a stable representation of this image for serialization
   */
  public toJSON(): string {
    return this._hash || this.image;
  }

  private createTempDir(): string {
    const tmpDir = os.tmpdir();
    const random = crypto.randomBytes(6).toString("hex");
    const dir = path.join(tmpDir, `cdktn-docker-cp-${random}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}
