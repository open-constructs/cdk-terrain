// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { flushTelemetry } from "@cdktn/commons";

/**
 * `beforeExit` handler for the success path: Sentry buffers metrics
 * asynchronously, so flush (bounded) and then exit explicitly, or an
 * unresponsive ingest endpoint keeps the transport socket and the process
 * alive. The flush runs once: awaiting it drains the loop and `beforeExit`
 * fires again. runCli does the same for failures.
 */
export function createBeforeExitFlush(
  exit: (code?: number | string) => void = (code) => process.exit(code),
): () => Promise<void> {
  let started = false;
  return async () => {
    if (started) {
      return;
    }
    started = true;
    await flushTelemetry();
    exit(process.exitCode ?? 0);
  };
}
