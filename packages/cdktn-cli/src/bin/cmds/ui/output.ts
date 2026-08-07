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
 * @param config - Output options. `onOutputsRetrieved` is called with the fetched outputs before they are printed;
 *                 it may return a promise (e.g. writing --outputs-file to disk), which is awaited and, if it
 *                 rejects, surfaced as a fatal External error (see the matching guard in `runDeploy`).
 * @returns Promise that resolves when outputs have been fetched and printed, rejects on failure. A failure only
 *          *rendering* the fetched outputs is non-fatal and does not cause a rejection.
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

    // See runDeploy() in ./deploy.ts for the rationale: a failed --outputs-file write must be
    // fatal, wrapped as an External error so cdktn.ts's top-level `.fail()` handler prints a
    // single clean line instead of a stack trace.
    try {
      await onOutputsRetrieved(outputs);
    } catch (e) {
      throw Errors.External(
        `Failed to write outputs${outputsPath ? ` to ${outputsPath}` : ""}: ${
          e instanceof Error ? e.message : e
        }`,
        e instanceof Error ? e : undefined,
      );
    }

    if (outputs && Object.keys(outputs).length > 0) {
      try {
        console.log(renderOutputs(outputs));
      } catch (e) {
        // The fetch - and the outputs write above - already succeeded at this point; a failure
        // rendering the outputs table is purely cosmetic and must not fail the command.
        console.error(
          `\nOutputs fetched, but rendering them failed: ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
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
