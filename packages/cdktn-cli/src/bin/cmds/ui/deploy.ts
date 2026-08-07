// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Errors } from "@cdktn/commons";
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
  onOutputsRetrieved: (outputs: NestedTerraformOutputs) => void | Promise<void>;
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
 * Drive a `cdktn deploy` invocation: stream logs above a pinned status bar, route approval/override prompts through
 * inquirer, and print final Terraform outputs.
 *
 * In non-TTY contexts an approval prompt cannot run; in that case the function logs a clear stderr message and calls
 * `status.stop()` so cli-core halts cleanly rather than hanging.
 *
 * @param config - All deploy options, forwarded near-verbatim to `CdktfProject.deploy`. `onOutputsRetrieved` is
 *                 invoked once the run completes (or is stopped) with the final outputs map, after the outputs
 *                 table has already been rendered; it may return a promise (e.g. writing --outputs-file to
 *                 disk), which is awaited and, if it rejects, surfaced as a fatal error since a broken outputs
 *                 write is a broken promise to the caller.
 * @returns Promise that resolves when the deploy completes, is stopped, or is dismissed. Rejects with whatever
 *          cli-core rejects with for real failures (terraform error, abort signal, etc.), or with a Usage error
 *          (bad --outputs-file path, e.g. ENOENT/ENOTDIR) or External error (any other `onOutputsRetrieved`
 *          failure). A failure only *rendering* the fetched outputs is non-fatal and does not cause a rejection.
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
          // Either no-TTY (PROMPT_NEEDS_TTY) or inquirer's Exit/Abort/Cancel — in every case the user cannot answer,
          // so stop the run cleanly.
          console.error(
            isNonTtyError(e)
              ? "\nApproval required but stdin is not a TTY. Re-run with --auto-approve. Stopping."
              : "\nApproval prompt cancelled. Stopping.",
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
          console.error(
            isNonTtyError(e)
              ? "\nSentinel override required but stdin is not a TTY. Rejecting."
              : "\nSentinel override prompt cancelled. Rejecting.",
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

    // Render the outputs table first (still non-fatal): the deploy already succeeded, so a
    // failure here is purely cosmetic, and rendering before the --outputs-file write below means
    // the user still sees their outputs even if that write fails.
    let rendered = "";
    let renderFailed = false;
    try {
      rendered = outputs ? renderOutputs(outputs) : "";
    } catch (e) {
      // The deploy already succeeded at this point; a failure rendering the outputs table is
      // purely cosmetic and must not fail the deploy. Log it so the user still learns something
      // went wrong, but do not rethrow.
      console.error(
        `\nDeploy succeeded, but rendering the outputs failed: ${
          e instanceof Error ? e.message : e
        }`,
      );
      renderFailed = true;
    }

    if (rendered) {
      console.log(rendered);
    } else if (!renderFailed) {
      // Either there were no declared outputs at all, or every one of them was dropped upstream
      // (e.g. all missing from `terraform output`, the empty-group case renderOutputs collapses
      // to ""). Either way there is nothing to show the user, so say so plainly instead of
      // printing a stray blank line.
      console.log("No outputs found.");
    }

    // A failed --outputs-file write is a broken promise to the user and must be fatal: await it
    // and rethrow as a clean error, which error-handling.ts's `reportFailure` prints as a
    // single clean line rather than a stack trace, since the deploy itself already succeeded (and
    // its outputs were already rendered above, so the write failure below does not hide them).
    // ENOENT/ENOTDIR means the user pointed --outputs-file at a path that doesn't exist - a usage
    // mistake, not something outside our control - so it is reported as a Usage error (excluded
    // from Sentry crash reporting) rather than External.
    try {
      await onOutputsRetrieved(outputs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      const ErrorCtor =
        code === "ENOENT" || code === "ENOTDIR"
          ? Errors.Usage
          : Errors.External;
      throw ErrorCtor(
        `Failed to write outputs: ${e instanceof Error ? e.message : e}`,
        e instanceof Error ? e : undefined,
      );
    }

    if (outputsPath) {
      console.log(`The outputs have been written to ${outputsPath}`);
    }
  } finally {
    stream.stop();
  }
}
