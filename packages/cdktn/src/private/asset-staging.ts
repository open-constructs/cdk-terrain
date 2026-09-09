// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { spawnSync, type SpawnSyncOptions } from "child_process";
import { type IConstruct } from "constructs";
import * as crypto from "crypto";
import * as os from "os";
import { Annotations } from "../annotations";
import { AssetStaging } from "../asset-staging";
import { type BundlingOptions } from "../bundling";
import { ExecutionError } from "../errors";

/**
 * Helper image used to own and seed the input/output volumes in VOLUME_COPY
 * mode. Pinned so bundling does not change underneath users when the upstream
 * tag moves; override with `CDKTN_BUNDLING_HELPER_IMAGE` if a mirror is needed.
 */
const DEFAULT_HELPER_IMAGE = "public.ecr.aws/docker/library/alpine:3.21";

/**
 * Options for Docker based bundling of assets
 */
interface AssetBundlingOptions extends BundlingOptions {
  /**
   * Path where the source files are located
   */
  readonly sourcePath: string;
  /**
   * Path where the output files should be stored
   */
  readonly bundleDir: string;
  /**
   * Construct that owns this bundling run, used to report cleanup warnings.
   */
  readonly scope: IConstruct;
}

/**
 * Base class for asset bundling implementations
 */
abstract class AssetBundlingBase {
  protected options: AssetBundlingOptions;
  constructor(options: AssetBundlingOptions) {
    this.options = options;
  }
  /**
   * Determines a useful default user if not given otherwise
   */
  protected determineUser() {
    let user: string;
    if (this.options.user) {
      user = this.options.user;
    } else {
      // Default to current user
      const userInfo = os.userInfo();
      user =
        userInfo.uid !== -1 // uid is -1 on Windows
          ? `${userInfo.uid}:${userInfo.gid}`
          : "1000:1000";
    }
    return user;
  }

  /**
   * Surface best-effort cleanup failures without failing the synth: the
   * bundling output is already valid, but leaked Docker resources are worth
   * telling the user about.
   */
  protected warnCleanupFailures(failures: string[]) {
    Annotations.of(this.options.scope).addWarning(
      `Failed to clean up Docker resources after bundling; they may need to be removed manually. ${failures.join("; ")}`,
    );
  }
}

/**
 * Bundles files with bind mount as copy method
 */
export class AssetBundlingBindMount extends AssetBundlingBase {
  /**
   * Bundle files with bind mount as copy method
   */
  public run() {
    this.options.image.run({
      command: this.options.command,
      user: this.determineUser(),
      environment: this.options.environment,
      entrypoint: this.options.entrypoint,
      workingDirectory:
        this.options.workingDirectory ?? AssetStaging.BUNDLING_INPUT_DIR,
      securityOpt: this.options.securityOpt,
      volumesFrom: this.options.volumesFrom,
      volumes: [
        {
          hostPath: this.options.sourcePath,
          containerPath: AssetStaging.BUNDLING_INPUT_DIR,
          readOnly: true,
        },
        {
          hostPath: this.options.bundleDir,
          containerPath: AssetStaging.BUNDLING_OUTPUT_DIR,
        },
        ...(this.options.volumes ?? []),
      ],
      network: this.options.network,
      platform: this.options.platform,
    });
  }
}

/**
 * Provides a helper container for copying bundling related files to specific input and output volumes
 */
export class AssetBundlingVolumeCopy extends AssetBundlingBase {
  /**
   * Name of the Docker volume that is used for the asset input
   */
  private inputVolumeName: string;
  /**
   * Name of the Docker volume that is used for the asset output
   */
  private outputVolumeName: string;
  /**
   * Name of the Docker helper container to copy files into the volume
   */
  public copyContainerName: string;

  constructor(options: AssetBundlingOptions) {
    super(options);
    const copySuffix = crypto.randomBytes(12).toString("hex");
    this.inputVolumeName = `assetInput${copySuffix}`;
    this.outputVolumeName = `assetOutput${copySuffix}`;
    this.copyContainerName = `copyContainer${copySuffix}`;
  }

  /**
   * Creates volumes for asset input and output
   */
  private prepareVolumes() {
    dockerExec(["volume", "create", this.inputVolumeName]);
    dockerExec(["volume", "create", this.outputVolumeName]);
  }

  /**
   * runs a helper container that holds volumes and does some preparation tasks
   * @param user The user that will later access these files and needs permissions to do so
   */
  private startHelperContainer(user: string) {
    dockerExec([
      "run",
      "--name",
      this.copyContainerName,
      "-v",
      `${this.inputVolumeName}:${AssetStaging.BUNDLING_INPUT_DIR}`,
      "-v",
      `${this.outputVolumeName}:${AssetStaging.BUNDLING_OUTPUT_DIR}`,
      process.env.CDKTN_BUNDLING_HELPER_IMAGE ?? DEFAULT_HELPER_IMAGE,
      "sh",
      "-c",
      `mkdir -p ${AssetStaging.BUNDLING_INPUT_DIR} && chown -R ${user} ${AssetStaging.BUNDLING_OUTPUT_DIR} && chown -R ${user} ${AssetStaging.BUNDLING_INPUT_DIR}`,
    ]);
  }

  /**
   * removes the Docker helper container
   */
  private cleanHelperContainer() {
    dockerExec(["rm", this.copyContainerName]);
  }

  /**
   * Tear down every resource this bundling run may have created. Each step is
   * attempted independently so one failure cannot strand the others, and the
   * whole teardown is best-effort: a cleanup failure must not mask the
   * bundling error (or fail an otherwise successful synth).
   */
  private cleanup() {
    const failures: string[] = [];

    for (const [what, remove] of [
      [this.copyContainerName, () => this.cleanHelperContainer()],
      [
        this.inputVolumeName,
        () => dockerExec(["volume", "rm", this.inputVolumeName]),
      ],
      [
        this.outputVolumeName,
        () => dockerExec(["volume", "rm", this.outputVolumeName]),
      ],
    ] as const) {
      try {
        remove();
      } catch (e) {
        failures.push(`${what}: ${(e as Error).message}`);
      }
    }

    return failures;
  }

  /**
   * copy files from the host where this is executed into the input volume
   * @param sourcePath - path to folder where files should be copied from - without trailing slash
   */
  private copyInputFrom(sourcePath: string) {
    dockerExec([
      "cp",
      `${sourcePath}/.`,
      `${this.copyContainerName}:${AssetStaging.BUNDLING_INPUT_DIR}`,
    ]);
  }

  /**
   * copy files from the output volume to the host where this is executed
   * @param outputPath - path to folder where files should be copied to - without trailing slash
   */
  private copyOutputTo(outputPath: string) {
    dockerExec([
      "cp",
      `${this.copyContainerName}:${AssetStaging.BUNDLING_OUTPUT_DIR}/.`,
      outputPath,
    ]);
  }

  /**
   * Bundle files with VOLUME_COPY method
   */
  public run() {
    const user = this.determineUser();

    // The try opens before any resource is created: a failure part-way through
    // volume creation or helper startup must still be cleaned up.
    try {
      this.prepareVolumes();
      this.startHelperContainer(user); // TODO handle user properly
      this.copyInputFrom(this.options.sourcePath);

      this.options.image.run({
        command: this.options.command,
        user: user,
        environment: this.options.environment,
        entrypoint: this.options.entrypoint,
        workingDirectory:
          this.options.workingDirectory ?? AssetStaging.BUNDLING_INPUT_DIR,
        securityOpt: this.options.securityOpt,
        volumes: this.options.volumes,
        volumesFrom: [
          this.copyContainerName,
          ...(this.options.volumesFrom ?? []),
        ],
        platform: this.options.platform,
        network: this.options.network,
      });

      this.copyOutputTo(this.options.bundleDir);
    } finally {
      const failures = this.cleanup();
      if (failures.length > 0) {
        this.warnCleanupFailures(failures);
      }
    }
  }
}

/**
 * Execute Docker CLI command
 *
 * @internal
 */
export function dockerExec(args: string[], options?: SpawnSyncOptions) {
  const prog = process.env.CDK_DOCKER ?? "docker";
  const proc = spawnSync(prog, args, {
    encoding: "utf-8",
    stdio: [
      // show Docker output
      "ignore", // ignore stdio
      // AWSCDK: process.stderr, // redirect stdout to stderr (causes radix error in bun?)
      "inherit",
      "inherit", // inherit stderr
    ],
    ...options,
    // Forwarded explicitly because a sandboxed `process.env` (as under Jest) is
    // not otherwise visible to the child.
    env: { ...process.env, ...options?.env },
  });

  if (proc.error) {
    throw proc.error;
  }

  if (proc.status !== 0) {
    const reason =
      proc.signal != null ? `signal ${proc.signal}` : `status ${proc.status}`;
    const command = [
      prog,
      ...args.map((arg) =>
        /[^a-z0-9_-]/i.test(arg) ? JSON.stringify(arg) : arg,
      ),
    ].join(" ");

    /**
     * Helper to prepend a label to each line of text
     */
    function prependLines(
      firstLine: string,
      text: Buffer | string | undefined,
    ): string[] {
      if (!text || text.length === 0) {
        return [];
      }
      const padding = " ".repeat(firstLine.length);
      return text
        .toString("utf-8")
        .split("\n")
        .map((line, idx) => `${idx === 0 ? firstLine : padding}${line}`);
    }

    throw new ExecutionError(
      [
        `${prog} exited with ${reason}`,
        ...(prependLines("--> STDOUT:  ", proc.stdout) ?? []),
        ...(prependLines("--> STDERR:  ", proc.stderr) ?? []),
        `--> Command: ${command}`,
      ].join("\n"),
    );
  }

  return proc;
}
