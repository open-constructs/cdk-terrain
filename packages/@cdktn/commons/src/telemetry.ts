// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

/**
 * Sends usage telemetry for a CLI command.
 *
 * The legacy HashiCorp checkpoint transport has been removed; this is
 * currently a no-op and will emit Sentry v10 metrics (gated by the
 * `sendUsageTelemetry` consent flag and `CHECKPOINT_DISABLE`) in a
 * follow-up change. The signature is preserved to avoid churn across
 * the existing call sites.
 */
export async function sendTelemetry(
  command: string,
  payload: Record<string, any>,
): Promise<void> {
  void command;
  void payload;
}
