// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as Sentry from "@sentry/node";
import * as path from "path";
import * as fs from "fs-extra";
import ciInfo from "ci-info";
import { logger } from "./logging";

/**
 * Reads the raw `sendUsageTelemetry` consent flag from `cdktf.json`.
 *
 * Returns `undefined` when the flag is unset or when no readable
 * `cdktf.json` exists (e.g. `cdktn convert` outside a project) — it never
 * invents a default. The effective enabled/disabled state is derived by
 * the consent-gating layer (`isUsageTelemetryEnabled` and the interactive
 * prompt flow in cli-core).
 *
 * NOTE: this deliberately does NOT go through the typed
 * `CdktfConfig.sendUsageTelemetry` getter (cli-core): commons cannot
 * import cli-core, and consent gating must work before/without a valid
 * project (no cdktf.json, or one the full config parser would reject).
 * The typed getter remains the validated surface for project-level
 * consumers; this reader is forgiving by design (malformed -> not
 * explicitly false -> legacy default applies).
 */
export function getUsageTelemetryConsent(
  projectPath = process.cwd(),
): boolean | undefined {
  try {
    const cdktfJson = JSON.parse(
      fs.readFileSync(path.resolve(projectPath, "cdktf.json"), "utf8"),
    );
    if (!("sendUsageTelemetry" in cdktfJson)) {
      return undefined;
    }
    // init templates render booleans as the strings "true"/"false"
    return typeof cdktfJson.sendUsageTelemetry === "boolean"
      ? cdktfJson.sendUsageTelemetry
      : cdktfJson.sendUsageTelemetry === "true";
  } catch {
    return undefined;
  }
}

// Captured once per invocation by the consent-gating step (cli-core's
// initializErrorReporting) while the process is still in the user's
// working directory. Commands like `convert` chdir into a throwaway
// project before emitting, so re-reading cdktf.json at emission time
// would consult the wrong consent context.
let usageTelemetryEnabledState: boolean | undefined;

export function setUsageTelemetryEnabled(enabled: boolean | undefined): void {
  usageTelemetryEnabledState = enabled;
}

/**
 * Effective usage-telemetry gate. Precedence (highest first):
 * 1. `CHECKPOINT_DISABLE` set -> disabled (backwards-compatible override;
 *    read at runtime, not import time, so tests can modify the env var)
 * 2. the decision captured at command start (`setUsageTelemetryEnabled`)
 * 3. `sendUsageTelemetry` explicitly set in `cdktf.json` -> honored
 * 4. unset -> enabled (legacy on-by-default usage telemetry; interactive
 *    runs are prompted-and-persisted before this is consulted)
 *
 * Crash reporting (`sendCrashReports`) is an independent concern and is
 * never affected by this gate.
 */
export function isUsageTelemetryEnabled(projectPath = process.cwd()): boolean {
  if (process.env.CHECKPOINT_DISABLE) {
    return false;
  }
  if (usageTelemetryEnabledState !== undefined) {
    return usageTelemetryEnabledState;
  }
  return getUsageTelemetryConsent(projectPath) !== false;
}

/**
 * Bounded flush of buffered telemetry. Required before any explicit
 * `process.exit()` on a path that may have emitted metrics — the legacy
 * checkpoint transport awaited its POST inline, but Sentry buffers
 * asynchronously and a hard exit drops the buffer.
 */
export async function flushTelemetry(timeoutMs = 4000): Promise<void> {
  try {
    await Sentry.flush(timeoutMs);
  } catch (err) {
    logger.debug(`Could not flush telemetry: ${err}`);
  }
}

/**
 * Sends usage telemetry for a CLI command as Sentry v10 metrics
 * (`cli.command.invoked`, `cli.command.error`, `cli.synth.duration`).
 *
 * A silent no-op when usage telemetry is disabled or Sentry is not
 * initialized (no DSN / user opted out). The signature is preserved from
 * the removed HashiCorp checkpoint transport to minimize call-site churn.
 */
export async function sendTelemetry(
  command: string,
  payload: Record<string, any>,
): Promise<void> {
  try {
    if (!isUsageTelemetryEnabled()) {
      return;
    }

    const ci: string | false = ciInfo.isCI ? ciInfo.name || "unknown" : false;
    const attributes: Record<string, string | boolean> = {
      command,
      ci: ci === false ? false : ci,
    };
    if (typeof payload.language === "string") {
      attributes.language = payload.language;
    }

    if (payload.error) {
      Sentry.metrics.count("cli.command.error", 1, { attributes });
      return;
    }

    Sentry.metrics.count("cli.command.invoked", 1, { attributes });
    if (typeof payload.totalTime === "number") {
      Sentry.metrics.distribution("cli.synth.duration", payload.totalTime, {
        unit: "millisecond",
        attributes,
      });
    }
  } catch (err) {
    logger.debug(`Could not send telemetry data: ${err}`);
  }
}
