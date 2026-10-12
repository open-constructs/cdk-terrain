// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { normalizeConsentFlag } from "./config";
import * as Sentry from "@sentry/node";
import * as path from "path";
import * as fs from "fs-extra";
import ciInfo from "ci-info";
import { logger } from "./logging";
import { LANGUAGES } from "./config";
import { processState } from "./process-state";

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
};

// Shared by both bundle copies: the handlers' copy captures the decision and
// starts the run, the entrypoint's copy counts the failure.
const state = processState<CommandTelemetryState>(
  "cdktn.commandTelemetry",
  () => ({}),
);

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

function commandAttributes(command: string, language: unknown): Attributes {
  const ci: string | false = ciInfo.isCI ? ciInfo.name || "unknown" : false;
  const attributes: Attributes = {
    command,
    ci: ci === false ? false : ci,
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
    const attributes = commandAttributes(command, state.language);
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

    const attributes = commandAttributes(
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
