// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Errors } from "@cdktn/commons";
import { NestedTerraformOutputs } from "@cdktn/cli-core";
import { runCdktfProject, Status } from "../helper/project-runner";
import { StreamRenderer } from "../helper/tty-stream";
import { renderOutputs } from "../helper/format";

/** Options accepted by {@link runOutput}. */
export interface OutputConfig {
  outDir: string;
  targetStacks?: string[];
  synthCommand: string;
  onOutputsRetrieved: (outputs: NestedTerraformOutputs) => void | Promise<void>;
  outputsPath?: string;
  skipSynth?: boolean;
  skipProviderLock?: boolean;
}

/**
 * Map a {@link Status} to the short bar text shown during `cdktn output`.
 *
 * @param status - Current project status.
 * @returns Bar text or empty string when no progress should be shown.
 */
function statusBar(status: Status): string {
  switch (status.type) {
    case "starting":
      return "Starting";
    case "synthesizing":
      return "Synthesizing";
    case "running":
      return "Processing";
    default:
      return "";
  }
}

/**
 * Drive a `cdktn output` invocation. Fetches Terraform outputs (optionally skipping synth/provider-lock), prints them
 * in nested form, and writes them to disk when `outputsPath` is provided.
 *
 * @param config - Output options. `onOutputsRetrieved` is called with the fetched outputs, after they have already
 *                 been printed; it may return a promise (e.g. writing --outputs-file to disk), which is awaited
 *                 and, if it rejects, surfaced as a fatal error (see the matching guard in `runDeploy`).
 * @returns Promise that resolves when outputs have been fetched and printed, rejects on failure. Rejects with a
 *          Usage error (bad --outputs-file path, e.g. ENOENT/ENOTDIR) or External error (any other
 *          `onOutputsRetrieved` failure). A failure only *rendering* the fetched outputs is non-fatal and does
 *          not cause a rejection.
 */
export async function runOutput({
  outDir,
  targetStacks,
  synthCommand,
  onOutputsRetrieved,
  outputsPath,
  skipSynth,
  skipProviderLock,
}: OutputConfig): Promise<void> {
  const stream = new StreamRenderer();
  stream.start();

  try {
    const { returnValue: outputs } = await runCdktfProject(
      {
        outDir,
        synthCommand,
        onStatus: (status) =>
          stream.setBar(statusBar(status), { spinner: true }),
        onLog: ({ stackName, message, messageWithConstructPath }) => {
          stream.appendLog({
            stackName,
            content: messageWithConstructPath ?? message,
          });
        },
      },
      (project) =>
        project.fetchOutputs({
          stackNames: targetStacks,
          skipSynth,
          skipProviderLock,
        }),
    );

    stream.clearBar();

    // Render the outputs table first (still non-fatal): the fetch already succeeded, so a
    // failure here is purely cosmetic, and rendering before the --outputs-file write below means
    // the user still sees their outputs even if that write fails.
    let rendered = "";
    let renderFailed = false;
    try {
      rendered = outputs ? renderOutputs(outputs) : "";
    } catch (e) {
      // The fetch already succeeded at this point; a failure rendering the outputs table is
      // purely cosmetic and must not fail the command. Log it so the user still learns something
      // went wrong, but do not rethrow.
      console.error(
        `\nOutputs fetched, but rendering them failed: ${
          e instanceof Error ? e.message : e
        }`,
      );
      renderFailed = true;
    }

    if (rendered) {
      console.log(rendered);
    } else if (!renderFailed) {
      console.log("No outputs found.");
    }

    // See runDeploy() in ./deploy.ts for the rationale: a failed --outputs-file write must be
    // fatal, wrapped as a clean error so cdktn.ts's top-level `.fail()` handler prints a single
    // clean line instead of a stack trace, since the outputs were already rendered above. A bad
    // path (ENOENT/ENOTDIR) is a usage mistake and reported as Usage, not External.
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
