// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as Sentry from "@sentry/node";
import * as path from "path";
import * as fs from "fs-extra";
import ciInfo from "ci-info";
import { logger } from "./logging";
import { DEFAULT_TARGET_VERSIONS } from "./config";
import { terraformCli, TerraformCliProbe } from "./terraform";

type AttributeValue = string | number | boolean;
type Attributes = Record<string, AttributeValue>;

/**
 * Raw `cdktf.json` read that never throws: telemetry must work outside a
 * project and must not depend on cli-core's typed config (commons cannot
 * import cli-core).
 */
function readRawCdktfJson(projectPath: string): Record<string, any> {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(projectPath, "cdktf.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

/**
 * Reads the raw `sendUsageTelemetry` flag from `cdktf.json`. Returns
 * `undefined` when the flag is unset or no readable `cdktf.json` exists;
 * `isUsageTelemetryEnabled` derives the effective state.
 */
export function getUsageTelemetryConsent(
  projectPath = process.cwd(),
): boolean | undefined {
  const cdktfJson = readRawCdktfJson(projectPath);
  if (!("sendUsageTelemetry" in cdktfJson)) {
    return undefined;
  }
  // init templates render booleans as the strings "true"/"false"
  return typeof cdktfJson.sendUsageTelemetry === "boolean"
    ? cdktfJson.sendUsageTelemetry
    : cdktfJson.sendUsageTelemetry === "true";
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
 * The project's declared Terraform/OpenTofu targets as metric attributes.
 * Falls back to the CLI defaults so every metric carries the ranges the
 * command actually validated against.
 */
export function getProjectTargetAttributes(
  projectPath = process.cwd(),
): Attributes {
  const cdktfJson = readRawCdktfJson(projectPath);
  const declared =
    cdktfJson.targetVersions &&
    typeof cdktfJson.targetVersions === "object" &&
    !Array.isArray(cdktfJson.targetVersions)
      ? cdktfJson.targetVersions
      : undefined;
  const targets: Record<string, unknown> = declared ?? DEFAULT_TARGET_VERSIONS;
  const attributes: Attributes = {
    targets_declared: declared !== undefined,
    validate_installed_binary: cdktfJson.validateInstalledBinary === true,
  };
  if (typeof targets.terraform === "string") {
    attributes.target_terraform = targets.terraform;
  }
  if (typeof targets.opentofu === "string") {
    attributes.target_opentofu = targets.opentofu;
  }
  return attributes;
}

// Captured alongside the consent decision, for the same reason: the project
// the user ran the command in, not the one the command may chdir into.
let projectTargetAttributes: Attributes | undefined;

export function setProjectTargetAttributes(
  attributes: Attributes | undefined,
): void {
  projectTargetAttributes = attributes;
}

/**
 * Binary attributes from the version probe, bounded so a hung binary never
 * delays the command; a timed-out probe reports `binary: "unknown"`.
 */
export async function getBinaryAttributes(
  probe: Promise<TerraformCliProbe> = terraformCli,
  timeoutMs = 1500,
): Promise<Attributes> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<TerraformCliProbe>((resolve) => {
    timer = setTimeout(() => resolve({ name: "unknown" }), timeoutMs);
  });
  try {
    const cli = await Promise.race([probe, timeout]);
    const attributes: Attributes = { binary: cli.name };
    if (cli.version) {
      attributes.binary_version = cli.version;
    }
    return attributes;
  } finally {
    clearTimeout(timer);
  }
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

// Scalar payload fields forwarded as attributes, per command. Anything not
// listed here (and every array/object) stays out of the metric.
const SCALAR_ATTRIBUTES: Record<string, Record<string, string>> = {
  synth: { synthOrigin: "synth_origin" },
  init: { template: "template", isRemote: "is_remote" },
  convert: {
    numberOfModules: "module_count",
    numberOfProviders: "provider_count",
    convertedLines: "converted_lines",
  },
  watch: { event: "event" },
};

function isScalar(value: unknown): value is AttributeValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
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
    const attributes: Attributes = {
      command,
      ci: ci === false ? false : ci,
      os: process.platform,
      arch: process.arch,
      ...(projectTargetAttributes ?? getProjectTargetAttributes()),
      ...(await getBinaryAttributes()),
    };
    if (typeof payload.language === "string") {
      attributes.language = payload.language;
    }
    for (const [key, attribute] of Object.entries(
      SCALAR_ATTRIBUTES[command] ?? {},
    )) {
      if (isScalar(payload[key])) {
        attributes[attribute] = payload[key];
      }
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
