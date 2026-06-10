// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { runCdktfProject, Status } from "../helper/project-runner";
import { StreamRenderer } from "../helper/tty-stream";
import { renderExecution } from "../helper/format";
import {
  promptApprove,
  promptOverride,
  isNonTtyError,
} from "../helper/prompts";

/** Options accepted by {@link runDestroy}. */
export interface DestroyConfig {
  outDir: string;
  targetStacks?: string[];
  synthCommand: string;
  autoApprove: boolean;
  ignoreMissingStackDependencies?: boolean;
  parallelism?: number;
  terraformParallelism?: number;
  noColor?: boolean;
  migrateState?: boolean;
  vars?: string[];
  varFiles?: string[];
  skipSynth?: boolean;
  skipProviderLock?: boolean;
}

/**
 * Drive a `cdktn destroy` invocation. Mirrors {@link runDeploy} (logs above
 * a pinned status bar, interactive approval/override via inquirer, clean
 * `status.stop()` in non-TTY contexts) without the trailing outputs print.
 *
 * @param config - Destroy options, forwarded near-verbatim to
 *   `CdktfProject.destroy`.
 * @returns Promise that resolves when the destroy completes, is stopped, or
 *   is dismissed. Rejects on real failures.
 */
export async function runDestroy({
  outDir,
  targetStacks,
  synthCommand,
  autoApprove,
  ignoreMissingStackDependencies,
  parallelism,
  terraformParallelism,
  noColor,
  migrateState,
  vars,
  varFiles,
  skipSynth,
  skipProviderLock,
}: DestroyConfig): Promise<void> {
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
            "destroying",
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
    await runCdktfProject(
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
      (project) =>
        project.destroy({
          stackNames: targetStacks,
          autoApprove,
          ignoreMissingStackDependencies,
          parallelism,
          terraformParallelism,
          noColor,
          migrateState,
          vars,
          varFiles,
          skipSynth,
          skipProviderLock,
        }),
    );
  } finally {
    stream.stop();
  }
}
