// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { runCdktfProject, Status } from "../helper/project-runner";
import { StreamRenderer } from "../helper/tty-stream";

/** Options accepted by {@link runDiff}. */
export interface DiffConfig {
  outDir: string;
  targetStack?: string;
  synthCommand: string;
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
 * Map a {@link Status} to the short bar text shown during `cdktn diff`.
 * Returns the empty string for non-progress statuses, which clears the bar.
 *
 * @param status - Current project status.
 * @returns Bar text or empty string.
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
 * Drive a `cdktn diff` (terraform plan) invocation. Streams logs above a
 * pinned spinner bar; no interactive prompts.
 *
 * @param config - Diff options, forwarded near-verbatim to
 *   `CdktfProject.diff`.
 * @returns Promise that resolves when the diff completes, rejects on
 *   failure.
 */
export async function runDiff({
  outDir,
  targetStack,
  synthCommand,
  refreshOnly,
  terraformParallelism,
  vars,
  varFiles,
  noColor,
  migrateState,
  skipSynth,
  skipProviderLock,
}: DiffConfig): Promise<void> {
  const stream = new StreamRenderer();
  stream.start();

  try {
    await runCdktfProject(
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
        project.diff({
          stackName: targetStack,
          refreshOnly,
          terraformParallelism,
          vars,
          varFiles,
          noColor,
          migrateState,
          skipSynth,
          skipProviderLock,
        }),
    );

    stream.clearBar();
  } finally {
    stream.stop();
  }
}
