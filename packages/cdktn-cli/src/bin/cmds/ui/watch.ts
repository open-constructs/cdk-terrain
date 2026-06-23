// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { watch } from "@cdktn/cli-core";
import { StreamRenderer } from "../helper/tty-stream";
import { renderWatchStatus } from "../helper/format";

/** Options accepted by {@link runWatch}. */
export interface WatchConfig {
  targetDir: string;
  targetStacks?: string[];
  parallelism?: number;
  synthCommand: string;
  autoApprove: boolean;
  terraformParallelism?: number;
}

type Signal = "SIGINT" | "SIGTERM" | "SIGQUIT";
const signals: Signal[] = ["SIGINT", "SIGTERM", "SIGQUIT"];

/**
 * Drive a long-running `cdktn watch` session. Sits in an event loop that triggers auto-approved deploys on file
 * changes, surfacing each deploy's progress in the pinned status bar.
 *
 * The session ends when the user sends SIGINT/SIGTERM/SIGQUIT, which is propagated to cli-core via an AbortController.
 *
 * @param config - Watch options. `autoApprove` is required (the wrapper in `handlers.ts` rejects invocations that omit it).
 * @returns Promise that resolves on graceful shutdown, rejects on unrecoverable failure.
 */
export async function runWatch({
  targetDir,
  targetStacks,
  synthCommand,
  autoApprove,
  parallelism,
  terraformParallelism,
}: WatchConfig): Promise<void> {
  const stream = new StreamRenderer();
  stream.start();

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  for (const sig of signals) process.on(sig, onAbort);

  try {
    await watch(
      {
        synthCommand,
        outDir: targetDir,
        onUpdate: () => {},
        onLog: ({ stackName, message, messageWithConstructPath }) => {
          stream.appendLog({
            stackName,
            content: messageWithConstructPath ?? message,
          });
        },
      },
      {
        autoApprove,
        stackNames: targetStacks,
        parallelism,
        terraformParallelism,
      },
      ac.signal as any,
      (state) => {
        const { text, spinner } = renderWatchStatus(state);
        stream.setBar(text, { spinner });
      },
    );
  } finally {
    for (const sig of signals) process.removeListener(sig, onAbort);
    stream.stop();
  }
}
