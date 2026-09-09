// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { normalizeConsentFlag } from "./config";
import * as Sentry from "@sentry/node";
import * as path from "path";
import * as fs from "fs-extra";
import * as semver from "semver";
import ciInfo from "ci-info";
import { logger } from "./logging";
import { DEFAULT_TARGET_VERSIONS, LANGUAGES } from "./config";
import { processState } from "./process-state";
import { terraformCli, TerraformCliProbe } from "./terraform";

type AttributeValue = string | number | boolean;
type Attributes = Record<string, AttributeValue>;

export const COMMAND_ERROR_TYPES = [
  "Usage",
  "External",
  "Internal",
  "unexpected",
] as const;
export type CommandErrorType = (typeof COMMAND_ERROR_TYPES)[number];

// Never throws: telemetry also runs outside a project. Raw, because commons
// cannot import cli-core's typed config.
function readRawCdktfJson(projectPath: string): Record<string, any> {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(projectPath, "cdktf.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

// undefined: unset, malformed, or no readable cdktf.json
export function getUsageTelemetryConsent(
  projectPath = process.cwd(),
): boolean | undefined {
  const cdktfJson = readRawCdktfJson(projectPath);
  if (!("sendUsageTelemetry" in cdktfJson)) {
    return undefined;
  }
  return normalizeConsentFlag(
    "sendUsageTelemetry",
    cdktfJson.sendUsageTelemetry,
  );
}

type CommandTelemetryState = {
  // Captured by initializErrorReporting (cli-core) while still in the user's
  // cwd: `convert` chdirs into a throwaway project before emitting, so
  // re-reading cdktf.json at emission time would consult the wrong project.
  usageTelemetryEnabled?: boolean;
  // The command this run was started as; set once by startCommandTelemetry so
  // the operations a command drives (a deploy's synth, the get of init or
  // provider add) never count as runs.
  startedCommand?: string;
  // The raw `language` of the project the run started in, so every metric of
  // the run (the error metric has no payload) carries the one `invoked` did.
  language?: unknown;
  // Captured alongside the consent decision, for the same reason: the project
  // the user ran the command in, not the one the command may chdir into.
  projectTargetAttributes?: Attributes;
};

// Shared by both bundle copies: the handlers' copy captures the decision and
// starts the run, the entrypoint's copy counts the failure.
const state = processState<CommandTelemetryState>(
  "cdktn.commandTelemetry",
  () => ({}),
);

// Free-text payload fields are validated before they become attributes so a
// misconfigured or hand-edited value never carries arbitrary text.
const RELEASE_VERSION = /^\d+\.\d+\.\d+/;

// MAJOR.MINOR.PATCH only: prerelease and build identifiers are free text
// (a wrapper's version line or a locally built library can carry anything).
function releaseVersion(value: string | undefined): string | undefined {
  return RELEASE_VERSION.exec(value ?? "")?.[0];
}

// Normalized so spacing variants collapse into one value; a prerelease or
// build identifier is free text and rejects the range (hyphen ranges are
// written " - ", so a hyphen right after a digit is always a prerelease).
function semverRangeOrInvalid(value: string): string {
  const range = value.length <= 64 ? semver.validRange(value) : null;
  return range && !/\d[-+]/.test(value) ? range : "invalid";
}

export function setUsageTelemetryEnabled(enabled: boolean | undefined): void {
  state.usageTelemetryEnabled = enabled;
}

// Once captured, the decision stands for the process; reporting is not
// initialized a second time.
export function hasCapturedUsageTelemetryDecision(): boolean {
  return state.usageTelemetryEnabled !== undefined;
}

// Precedence: CHECKPOINT_DISABLE > the decision captured at command start >
// `sendUsageTelemetry` in cdktf.json > enabled.
export function isUsageTelemetryEnabled(projectPath = process.cwd()): boolean {
  if (process.env.CHECKPOINT_DISABLE) {
    return false;
  }
  if (state.usageTelemetryEnabled !== undefined) {
    return state.usageTelemetryEnabled;
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
    attributes.target_terraform = semverRangeOrInvalid(targets.terraform);
  }
  if (typeof targets.opentofu === "string") {
    attributes.target_opentofu = semverRangeOrInvalid(targets.opentofu);
  }
  return attributes;
}

export function setProjectTargetAttributes(
  attributes: Attributes | undefined,
): void {
  state.projectTargetAttributes = attributes;
}

/**
 * Binary attributes from the version probe, bounded so a hung binary never
 * delays the command; a timed-out probe reports `binary: "unknown"`.
 */
export async function getBinaryAttributes(
  probe: Promise<TerraformCliProbe> = terraformCli(),
  timeoutMs = 1500,
): Promise<Attributes> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<TerraformCliProbe>((resolve) => {
    timer = setTimeout(() => resolve({ name: "unknown" }), timeoutMs);
  });
  try {
    const cli = await Promise.race([probe, timeout]);
    const attributes: Attributes = { binary: cli.name };
    // an unrecognised product's version is the first version-like token of
    // its output, which can be anything (a wrapper's "connected to 10.0.0.1")
    const release =
      cli.name === "terraform" || cli.name === "opentofu"
        ? releaseVersion(cli.version)
        : undefined;
    if (release) {
      attributes.binary_version = release;
    }
    return attributes;
  } finally {
    clearTimeout(timer);
  }
}

// By type and command only: message and context can carry paths and user
// input.
export function sendErrorTelemetry(type: string, command: string): void {
  try {
    if (!isUsageTelemetryEnabled()) {
      return;
    }
    Sentry.metrics.count("cli.error", 1, { attributes: { type, command } });
  } catch (err) {
    logger.debug(`Could not send error telemetry: ${err}`);
  }
}

// Call before an explicit process.exit(): Sentry buffers asynchronously and
// a hard exit drops the buffer.
export async function flushTelemetry(timeoutMs = 4000): Promise<void> {
  try {
    await Sentry.flush(timeoutMs);
  } catch (err) {
    logger.debug(`Could not flush telemetry: ${err}`);
  }
}

async function commandAttributes(
  command: string,
  language: unknown,
): Promise<Attributes> {
  const ci: string | false = ciInfo.isCI ? ciInfo.name || "unknown" : false;
  const attributes: Attributes = {
    command,
    ci: ci === false ? false : ci,
    os: process.platform,
    arch: process.arch,
    ...(state.projectTargetAttributes ?? getProjectTargetAttributes()),
    ...(await getBinaryAttributes()),
  };
  if (LANGUAGES.includes(language as any)) {
    attributes.language = language as string;
  }
  return attributes;
}

// Counts the attempt, whatever its outcome. Runs after consent is captured
// and Sentry initialized; later calls in the same process are no-ops.
export async function startCommandTelemetry(
  command: string,
  projectPath = process.cwd(),
): Promise<void> {
  if (state.startedCommand !== undefined) {
    return;
  }
  state.startedCommand = command;
  state.language = readRawCdktfJson(projectPath).language;
  try {
    if (!isUsageTelemetryEnabled()) {
      return;
    }
    const attributes = await commandAttributes(command, state.language);
    Sentry.metrics.count("cli.command.invoked", 1, { attributes });
  } catch (err) {
    logger.debug(`Could not send telemetry data: ${err}`);
  }
}

/** Forgets the started run; tests run many commands in one process. */
export function resetCommandTelemetry(): void {
  state.startedCommand = undefined;
  state.language = undefined;
}

// Payload fields reach the attributes only through the allow-lists above.
// A no-op when usage telemetry is disabled or Sentry is not initialized;
// `payload.error` counts the run as cli.command.error instead.
export async function sendTelemetry(
  command: string,
  payload: Record<string, any>,
): Promise<void> {
  try {
    if (!isUsageTelemetryEnabled()) {
      return;
    }

    const attributes = await commandAttributes(
      command,
      payload.language ?? state.language,
    );

    if (payload.error) {
      attributes.error_type = COMMAND_ERROR_TYPES.includes(payload.errorType)
        ? payload.errorType
        : "unexpected";
      Sentry.metrics.count("cli.command.error", 1, { attributes });
      return;
    }

    if (
      state.startedCommand === undefined ||
      state.startedCommand === command
    ) {
      Sentry.metrics.count("cli.command.completed", 1, { attributes });
    }
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
