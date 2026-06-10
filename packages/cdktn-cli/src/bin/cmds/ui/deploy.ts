// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { NestedTerraformOutputs } from "@cdktn/cli-core";
import { runCdktfProject, Status } from "../helper/project-runner";
import { StreamRenderer } from "../helper/tty-stream";
import { renderExecution, renderOutputs } from "../helper/format";
import {
  promptApprove,
  promptOverride,
  isNonTtyError,
} from "../helper/prompts";

/** Options accepted by {@link runDeploy}. */
export interface DeployConfig {
  outDir: string;
  targetStacks?: string[];
  synthCommand: string;
  autoApprove: boolean;
  onOutputsRetrieved: (outputs: NestedTerraformOutputs) => void;
  outputsPath?: string;
  ignoreMissingStackDependencies?: boolean;
  parallelism?: number;
  refreshOnly?: boolean;
  terraformParallelism?: number;
  vars?: string[];
  varFiles?: string[];
  noColor?: boolean;
  migrateState?: boolean;
  skipSynth?: boolean;
  skipProviderLock?: boolean;
}

/**
 * Drive a `cdktn deploy` invocation: stream logs above a pinned status bar,
 * route approval/override prompts through inquirer, and print final
 * Terraform outputs.
 *
 * In non-TTY contexts an approval prompt cannot run; in that case the
 * function logs a clear stderr message and calls `status.stop()` so
 * cli-core halts cleanly rather than hanging.
 *
 * @param config - All deploy options, forwarded near-verbatim to
 *   `CdktfProject.deploy`. `onOutputsRetrieved` is invoked once the run
 *   completes (or is stopped) with the final outputs map.
 * @returns Promise that resolves when the deploy completes, is stopped, or
 *   is dismissed. Rejects with whatever cli-core rejects with for real
 *   failures (terraform error, abort signal, etc.).
 */
export async function runDeploy({
  outDir,
  targetStacks,
  synthCommand,
  autoApprove,
  onOutputsRetrieved,
  outputsPath,
  ignoreMissingStackDependencies,
  parallelism,
  refreshOnly,
  terraformParallelism,
  vars,
  varFiles,
  noColor,
  migrateState,
  skipSynth,
  skipProviderLock,
}: DeployConfig): Promise<void> {
  const stream = new StreamRenderer();
  stream.start();

  const handleStatus = async (status: Status) => {
    switch (status.type) {
      case "starting":
        stream.setBar("Starting", { spinner: true });
        return;
      case "synthesizing":
        stream.setBar("Synthesizing", { spinner: true });
        return;
      case "running":
        stream.setBar(
          renderExecution(
            status.inProgress,
            status.finished,
            status.pending,
            "deploying",
          ),
        );
        return;
      case "waiting for approval of stack": {
        stream.pause();
        try {
          const answer = await promptApprove(status.stackName);
          if (answer === "approve") status.approve();
          else if (answer === "dismiss") status.dismiss();
          else status.stop();
        } catch (e) {
          if (!isNonTtyError(e)) throw e;
          console.error(
            "\nApproval required but stdin is not a TTY. Re-run with --auto-approve. Stopping.",
          );
          status.stop();
        } finally {
          stream.resume();
        }
        return;
      }
      case "waiting for override of sentinel policy check failure": {
        stream.pause();
        try {
          const answer = await promptOverride(status.stackName);
          if (answer === "override") status.override();
          else status.reject();
        } catch (e) {
          if (!isNonTtyError(e)) throw e;
          console.error(
            "\nSentinel override required but stdin is not a TTY. Rejecting.",
          );
          status.reject();
        } finally {
          stream.resume();
        }
        return;
      }
      case "done":
        stream.clearBar();
        return;
    }
  };

  try {
    const { project } = await runCdktfProject(
      {
        outDir,
        synthCommand,
        onStatus: handleStatus,
        onLog: ({ stackName, message, messageWithConstructPath }) => {
          stream.appendLog({
            stackName,
            content: messageWithConstructPath ?? message,
          });
        },
      },
      async (p) => {
        await p.deploy({
          stackNames: targetStacks,
          autoApprove,
          ignoreMissingStackDependencies,
          parallelism,
          refreshOnly,
          terraformParallelism,
          vars,
          varFiles,
          noColor,
          migrateState,
          skipSynth,
          skipProviderLock,
        });
      },
    );

    const outputs = project.outputsByConstructId;
    onOutputsRetrieved(outputs);

    if (outputs && Object.keys(outputs).length > 0) {
      console.log(renderOutputs(outputs));
      if (outputsPath) {
        console.log(`The outputs have been written to ${outputsPath}`);
      }
    } else {
      console.log("No outputs found.");
    }
  } finally {
    stream.stop();
  }
}
