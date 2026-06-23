// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { runCdktfProject, Status } from "../helper/project-runner";
import { StreamRenderer } from "../helper/tty-stream";

/** Options accepted by {@link runSynth}. */
export interface SynthConfig {
  outDir: string;
  synthCommand: string;
  hcl: boolean;
}

/**
 * Map a {@link Status} to the short bar text shown during `cdktn synth`.
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
 * Drive a `cdktn synth` invocation. Streams synthesis logs above a pinned spinner bar, then prints a summary line
 * listing the stacks produced.
 *
 * @param config - Synth options, forwarded to `CdktfProject.synth`.
 * @returns Promise that resolves when synthesis completes, rejects on failure.
 */
export async function runSynth({
  outDir,
  synthCommand,
  hcl,
}: SynthConfig): Promise<void> {
  const stream = new StreamRenderer();
  stream.start();

  try {
    const { returnValue } = await runCdktfProject(
      {
        outDir,
        synthCommand,
        hcl,
        onStatus: (status) =>
          stream.setBar(statusBar(status), { spinner: true }),
        onLog: ({ stackName, message, messageWithConstructPath }) => {
          stream.appendLog({
            stackName,
            content: messageWithConstructPath ?? message,
          });
        },
      },
      (project) => project.synth(),
    );

    stream.clearBar();
    const stacks = returnValue ?? [];
    console.log(
      `Generated Terraform code for the stacks: ${stacks.map((s) => s.name).join(", ")}`,
    );
  } finally {
    stream.stop();
  }
}
