// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as Sentry from "@sentry/node";
import * as path from "path";
import * as fs from "fs-extra";
import ciInfo from "ci-info";
import { logger } from "./logging";

/**
 * Reads the raw `sendUsageTelemetry` flag from `cdktf.json`. Returns
 * `undefined` when the flag is unset or no readable `cdktf.json` exists;
 * `isUsageTelemetryEnabled` derives the effective state.
 *
 * Does not use cli-core's typed `CdktfConfig` getter: commons cannot import
 * cli-core, and consent must be readable without a valid project.
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

// Captured by initializErrorReporting (cli-core) while still in the user's
// cwd: `convert` chdirs into a throwaway project before emitting, so
// re-reading cdktf.json at emission time would consult the wrong project.
let usageTelemetryEnabledState: boolean | undefined;

export function setUsageTelemetryEnabled(enabled: boolean | undefined): void {
  usageTelemetryEnabledState = enabled;
}

/**
 * Effective usage-telemetry gate, highest precedence first:
 * 1. `CHECKPOINT_DISABLE` set -> disabled
 * 2. the decision captured at command start (`setUsageTelemetryEnabled`)
 * 3. `sendUsageTelemetry` set in `cdktf.json`
 * 4. unset -> enabled
 * Independent of crash reporting (`sendCrashReports`).
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
 * Bounded flush of buffered telemetry. Call before any explicit
 * `process.exit()` on a path that may have emitted metrics: Sentry buffers
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
 * initialized (no DSN / user opted out).
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
