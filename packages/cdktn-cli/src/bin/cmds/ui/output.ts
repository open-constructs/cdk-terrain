// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { NestedTerraformOutputs } from "@cdktn/cli-core";
import { runCdktfProject, Status } from "../helper/project-runner";
import { StreamRenderer } from "../helper/tty-stream";
import { presentOutputs } from "../helper/outputs";

/** Options accepted by {@link runOutput}. */
export interface OutputConfig {
  outDir: string;
  targetStacks?: string[];
  synthCommand: string;
  onOutputsRetrieved: (outputs: NestedTerraformOutputs) => void;
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
 * @param config - Output options. `onOutputsRetrieved` is called with the fetched outputs before they are printed.
 * @returns Promise that resolves when outputs have been fetched and printed, rejects on failure.
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
    const { returnValue } = await runCdktfProject(
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
    presentOutputs({
      outputs: returnValue,
      onOutputsRetrieved,
      outputsPath,
      renderFailureLabel: "Outputs fetched",
    });
  } finally {
    stream.stop();
  }
}
