// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import stripAnsi from "strip-ansi";
import {
  Errors,
  exec,
  logger,
  readCDKTFVersion,
  terraformBinaryName,
} from "@cdktn/commons";
import {
  Terraform,
  TerraformPlan,
  TerraformOutput,
  AbstractTerraformPlan,
  TerraformDeployState,
} from "./terraform";
import { SynthesizedStack } from "../synth-stack";
import {
  createAndStartDeployService,
  createAndStartDestroyService,
  DeployActor,
  DeployInspectionHandler,
  DeploySnapshot,
  isDeployEvent,
} from "./deploy-machine";
import { waitFor } from "xstate";
import { missingVariable } from "../errors";
import { terraformJsonSchema } from "../terraform-json";
import { spawnInteractive } from "./interactive-process";
import path from "path";
import * as fs from "fs-extra";

const GENERATE_CONFIG_OUT_FILE = "generated_resources.tf";

export class TerraformCliPlan
  extends AbstractTerraformPlan
  implements TerraformPlan
{
  constructor(
    public readonly planFile: string,
    public readonly plan: { [key: string]: any },
  ) {
    super(planFile, plan?.resource_changes, plan?.output_changes);
  }
}

abstract class AbstractOutputFilter {
  public static condition: (line: string) => boolean;
  public static transform: (line: string) => string;
}
export type OutputFilter = typeof AbstractOutputFilter;

// The plan might error if there is a variable missing, but the error message hints the user
// in a wrong direction. We therefore catch the error and rethrow it with a more helpful message
class VariableRequiredFilter extends AbstractOutputFilter {
  // Example for "No value for required variable" error
  // ╷
  // │ Error: No value for required variable
  // │
  // │   on cdk.tf.json line 31, in variable:
  // │   31:     "with-dashes": {
  // │
  // │ The root module input variable "with-dashes" is not set, and has no default
  // │ value. Use a -var or -var-file command line argument to provide a value for
  // │ this variable
  public static condition(input: string) {
    const line = stripAnsi(input);

    return (
      line.includes("Error: No value for required variable") &&
      line.includes("The root module input variable")
    );
  }
  public static transform(line: string) {
    const startMarker = 'The root module input variable "';
    const variableName = line.substring(
      line.indexOf(startMarker) + startMarker.length,
      line.indexOf('" is not set'),
    );

    return missingVariable(variableName);
  }
}

export class TerraformCli implements Terraform {
  public readonly workdir: string;
  private readonly onStdout: (
    stateName: string,
    filter?: OutputFilter[],
  ) => (stdout: Buffer | string) => void;
  private readonly onStderr: (
    stateName: string,
    filter?: OutputFilter[],
  ) => (stderr: string | Uint8Array) => void;

  constructor(
    private readonly abortSignal: AbortSignal,
    public readonly stack: SynthesizedStack,
    createTerraformLogHandler = (_phase: string, _filter?: OutputFilter[]) =>
      (_stdout: string, _isErr = false) => {},
  ) {
    this.workdir = stack.workingDirectory;
    this.onStdout =
      (phase: string, filter?: OutputFilter[]) => (stdout: Buffer | string) =>
        createTerraformLogHandler(
          phase,
          filter,
        )(Buffer.isBuffer(stdout) ? stdout.toString() : stdout);
    this.onStderr =
      (phase: string, filter?: OutputFilter[]) =>
      (stderr: string | Uint8Array) =>
        createTerraformLogHandler(phase, filter)(stderr.toString(), true);
  }

  public async init(opts: {
    needsUpgrade: boolean;
    noColor?: boolean;
    migrateState: boolean;
    needsLockfileUpdate: boolean;
  }): Promise<void> {
    await this.setUserAgent();

    const args = ["init"];
    if (opts.needsUpgrade) {
      args.push("-upgrade");
    }
    if (opts.noColor) {
      args.push("-no-color");
    }
    if (opts.migrateState) {
      args.push("-migrate-state");
    }

    let initCanNotContinue = (_err: any) => {};
    const rejectsIfInitCanNotContinue = new Promise((_resolve, reject) => {
      initCanNotContinue = reject;
    });

    const stdout = this.onStdout("init");
    const { actions, exitCode } = spawnInteractive(
      {
        file: terraformBinaryName,
        args,
        options: {
          cwd: this.workdir,
          env: process.env as any,
        },
      },
      (data) => {
        stdout(data);
        if (
          data.includes("Should Terraform migrate your existing state?") ||
          data.includes("Do you want to copy existing state to the new backend")
        ) {
          // TODO: This only happens when terraform is passed the -migrate-state anyway, so this check is redundant
          if (opts.migrateState) {
            actions.writeLine("yes");
          } else {
            actions.stop();
            initCanNotContinue(
              "Please pass the --migrate-state flag to migrate your state",
            );
          }
        }
      },
    );
    this.abortSignal.addEventListener("abort", () => {
      actions.stop();
    });

    const progress = exitCode.then((code) => {
      if (code !== 0) {
        throw new Error(`terraform init failed with exit code ${code}`);
      }
    });
    await Promise.race([progress, rejectsIfInitCanNotContinue]);

    // TODO: this might have performance implications because we don't know if we're
    // running a remote plan or a local one (so we run it always for all platforms)
    // while we'd only need it for remote plans
    if (opts.needsLockfileUpdate) {
      await exec(
        terraformBinaryName,
        [
          "providers",
          "lock",
          "-platform=linux_amd64",
          ...(opts.noColor ? ["-no-color"] : []),
        ],
        {
          cwd: this.workdir,
          env: process.env,
          signal: this.abortSignal,
          noColor: opts.noColor,
        },
        this.onStdout("init"),
        this.onStderr("init"),
      );
    }
  }

  private get isCloudStack(): boolean {
    const parsedStack = terraformJsonSchema.parse(
      JSON.parse(this.stack.content),
    );

    return Boolean(
      parsedStack.terraform?.backend?.remote || parsedStack.terraform?.cloud,
    );
  }

  private get hasImports(): boolean {
    const parsedStack = terraformJsonSchema.parse(
      JSON.parse(this.stack.content),
    );

    return Boolean(parsedStack.import);
  }

  public async plan(opts: {
    destroy: boolean;
    refreshOnly?: boolean;
    parallelism?: number;
    vars?: string[];
    varFiles?: string[];
    noColor?: boolean;
  }): Promise<void> {
    const {
      destroy = false,
      refreshOnly = false,
      parallelism = -1,
      vars = [],
      varFiles = [],
      noColor = false,
    } = opts;
    const options = ["plan", "-input=false"];

    const generatedConfigFile = path.join(
      this.workdir,
      GENERATE_CONFIG_OUT_FILE,
    );
    if (fs.existsSync(generatedConfigFile)) {
      fs.remove(generatedConfigFile);
    }
    if (this.hasImports) {
      options.push(`-generate-config-out=${GENERATE_CONFIG_OUT_FILE}`);
    }
    if (!this.isCloudStack) {
      const planFile = "plan";
      options.push("-out", planFile);
    }

    if (destroy) {
      options.push("-destroy");
    }
    if (refreshOnly) {
      options.push("-refresh-only");
    }
    if (parallelism > -1) {
      options.push(`-parallelism=${parallelism}`);
    }
    if (noColor) {
      options.push("-no-color");
    }

    vars.forEach((v) => options.push(`-var=${v}`));
    varFiles.forEach((v) => options.push(`-var-file=${v}`));

    logger.debug(
      `Executing ${terraformBinaryName} ${options.join(" ")} in ${this.workdir}`,
    );

    await this.setUserAgent();

    await exec(
      terraformBinaryName,
      options,
      {
        cwd: this.workdir,
        env: process.env,
        signal: this.abortSignal,
        noColor,
      },
      this.onStdout("plan", [VariableRequiredFilter]),
      this.onStderr("plan", [VariableRequiredFilter]),
    );
  }

  public async deploy(
    {
      autoApprove = false,
      refreshOnly = false,
      noColor = false,
      parallelism = -1,
      extraOptions = [],
      vars = [],
      varFiles = [],
    },
    callback: (state: TerraformDeployState) => void,
  ): Promise<{ cancelled: boolean }> {
    await this.setUserAgent();
    return this.handleService("deploy", callback, (inspect) =>
      createAndStartDeployService(
        {
          terraformBinaryName,
          workdir: this.workdir,
          refreshOnly,
          noColor,
          autoApprove,
          parallelism,
          extraOptions,
          vars,
          varFiles,
        },
        inspect,
      ),
    );
  }

  public async destroy(
    {
      autoApprove = false,
      parallelism = -1,
      noColor = false,
      extraOptions = [],
      vars = [],
      varFiles = [],
    },
    callback: (state: TerraformDeployState) => void,
  ): Promise<{ cancelled: boolean }> {
    await this.setUserAgent();
    return this.handleService("destroy", callback, (inspect) =>
      createAndStartDestroyService(
        {
          terraformBinaryName,
          workdir: this.workdir,
          autoApprove,
          parallelism,
          noColor,
          extraOptions,
          vars,
          varFiles,
        },
        inspect,
      ),
    );
  }

  private async handleService(
    type: "deploy" | "destroy",
    callback: (state: TerraformDeployState) => void,
    createService: (inspect: DeployInspectionHandler) => DeployActor,
  ): Promise<{ cancelled: boolean }> {
    // Events reach us through inspection, which fires for the whole actor tree. Filter to the root deploy actor
    // (its sessionId equals the tree's rootId) so we don't react to the invoked pty child's own events. Comparing
    // sessionId rather than the actor ref keeps this self-contained: inspection fires during startup, before the
    // `service` binding below is initialized.
    const inspect: DeployInspectionHandler = (inspectionEvent) => {
      if (
        inspectionEvent.type !== "@xstate.event" ||
        inspectionEvent.actorRef.sessionId !== inspectionEvent.rootId
      ) {
        return;
      }

      const event = inspectionEvent.event;
      logger.trace(
        `Terraform CLI state machine event: ${JSON.stringify(event)}`,
      );
      if (isDeployEvent(event, "OUTPUT_RECEIVED"))
        this.onStdout(type)(event.output);
      else if (isDeployEvent(event, "APPROVED_EXTERNALLY"))
        callback({ type: "external approval reply", approved: true });
      else if (isDeployEvent(event, "REJECTED_EXTERNALLY"))
        callback({ type: "external approval reply", approved: false });
      else if (isDeployEvent(event, "OVERRIDDEN_EXTERNALLY"))
        callback({
          type: "external sentinel override reply",
          overridden: true,
        });
      else if (isDeployEvent(event, "OVERRIDE_REJECTED_EXTERNALLY"))
        callback({
          type: "external sentinel override reply",
          overridden: false,
        });
    };

    const service = createService(inspect);

    // Transitions come from the actor's own subscription, which yields typed snapshots for the root actor only.
    let previousState: DeploySnapshot["value"] = "idle";
    const handleSnapshot = (snapshot: DeploySnapshot) => {
      // Only send updates on actual state change; a snapshot is emitted even when only an event happened.
      if (snapshot.matches(previousState)) return;

      logger.trace(
        `Terraform CLI state machine state transition: ${JSON.stringify(
          previousState,
        )} => ${JSON.stringify(snapshot.value)}`,
      );

      if (snapshot.matches({ running: "awaiting_approval" })) {
        callback({
          type: "waiting for approval",
          approve: () => service.send({ type: "APPROVE" }),
          reject: () => service.send({ type: "REJECT" }),
        });
      } else if (snapshot.matches({ running: "awaiting_sentinel_override" })) {
        callback({
          type: "waiting for sentinel override",
          override: () => service.send({ type: "OVERRIDE" }),
          reject: () => service.send({ type: "REJECT_OVERRIDE" }),
        });
      } else if (snapshot.matches({ running: "processing" })) {
        callback({
          type: "running",
          cancelled: Boolean(snapshot.context.cancelled),
        });
      }
      previousState = snapshot.value;
    };

    service.subscribe(handleSnapshot);
    handleSnapshot(service.getSnapshot());

    // stop terraform apply if signaled as such from the outside (e.g. via ctrl+c)
    this.abortSignal.addEventListener(
      "abort",
      () => {
        service.send({ type: "STOP" });
      },
      { once: true },
    );

    const snapshot = await waitFor(
      service,
      (snapshot) => snapshot.status === "done",
      {
        timeout: Infinity,
      },
    );

    // The final state produces the terraform exit code as the machine's output.
    const exitCode = snapshot.output?.exitCode;

    logger.trace(
      `Invoking Terraform CLI for ${type} done (state machine reached final state). Last exit code: ${JSON.stringify(
        exitCode,
      )}. Context: ${JSON.stringify(snapshot.context)}`,
    );

    if (
      exitCode !== undefined &&
      exitCode !== 0 &&
      !snapshot.context.cancelled // don't fail if we cancelled the run
    ) {
      throw `Invoking Terraform CLI failed with exit code ${exitCode}`;
    }

    return { cancelled: Boolean(snapshot.context.cancelled) };
  }

  public async version(): Promise<string> {
    try {
      return await exec(
        terraformBinaryName,
        ["-v"],
        {
          cwd: this.workdir,
          env: process.env,
          signal: this.abortSignal,
          noColor: true,
        },
        this.onStdout("version"),
        this.onStderr("version"),
      );
    } catch {
      throw new Error(
        "Terraform CLI not present - Please install a current version https://learn.hashicorp.com/terraform/getting-started/install.html",
      );
    }
  }

  public async output(): Promise<{ [key: string]: TerraformOutput }> {
    const output = await exec(
      terraformBinaryName,
      ["output", "-json"],
      {
        cwd: this.workdir,
        env: process.env,
        signal: this.abortSignal,
        noColor: true,
      },
      // We don't need to log the output here since we use it later on
      () => {},
      this.onStderr("output"),
    );

    try {
      return JSON.parse(output);
    } catch (e) {
      throw Errors.External(
        `Failed to parse terraform output: ${e}. The output was '${output}'`,
      );
    }
  }

  public async setUserAgent(): Promise<void> {
    // Read the cdktf version from the 'cdk.tf.json' file
    // and set the user agent.
    const version = await readCDKTFVersion(this.workdir);
    if (version != "") {
      process.env.TF_APPEND_USER_AGENT =
        "cdktn/" +
        version +
        " (+https://github.com/open-constructs/cdk-terrain)";
    }
  }

  // We don't need to clean anything up for a running execution in the CLI since there is no left-over state in contrast to an open Terraform Cloud run
  public async abort() {
    return;
  }
}

export async function tryReadGeneratedConfigurationFile(
  workingDir: string,
): Promise<string | null> {
  const generatedConfigPath = path.join(workingDir, GENERATE_CONFIG_OUT_FILE);
  if (!fs.existsSync(generatedConfigPath)) {
    return null;
  }
  return fs.readFileSync(generatedConfigPath, "utf-8");
}

export async function tryRemoveGeneratedConfigurationFile(workingDir: string) {
  const generatedConfigPath = path.join(workingDir, GENERATE_CONFIG_OUT_FILE);
  if (fs.existsSync(generatedConfigPath)) {
    fs.unlinkSync(generatedConfigPath);
  }
}
