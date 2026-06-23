// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { runCdktfProject, Status } from "../helper/project-runner";
import { StreamRenderer } from "../helper/tty-stream";
import { renderStackList } from "../helper/format";

/** Options accepted by {@link runList}. */
export interface ListConfig {
  outDir: string;
  synthCommand: string;
}

/**
 * Map a {@link Status} to the short bar text shown during `cdktn list`.
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
 * Drive a `cdktn list` invocation. Synthesises the project, streaming logs above a pinned spinner bar, then prints a
 * two-column "Stack name / Path" table.
 *
 * @param config - List options, forwarded to `CdktfProject.synth`.
 * @returns Promise that resolves when listing completes, rejects on failure.
 */
export async function runList({
  outDir,
  synthCommand,
}: ListConfig): Promise<void> {
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
      (project) => project.synth(),
    );

    stream.clearBar();
    console.log(renderStackList(returnValue ?? []));
  } finally {
    stream.stop();
  }
}
