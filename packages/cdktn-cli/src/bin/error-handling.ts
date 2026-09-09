// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as yargs from "yargs";
import * as Sentry from "@sentry/node";
import {
  CommandErrorType,
  Errors,
  IsErrorType,
  collectDebugInformation,
  commandErrorType,
  flushTelemetry,
  sendTelemetry,
} from "@cdktn/commons";

export type CliFailure = { message?: string | null; error?: unknown };

export interface FailureReporterDeps {
  log(msg: string): void; // default: console.log
  logError(msg: string): void; // default: console.error
  collectDebugInformation(): Promise<Record<string, unknown>>;
  captureException(error: unknown): void; // default: Sentry.captureException
  // default: commons sendTelemetry, which applies the usage-telemetry gate
  sendCommandErrorTelemetry(
    command: string,
    errorType: CommandErrorType,
  ): Promise<void>;
  flushTelemetry(timeoutMs: number): Promise<void>; // default: commons flushTelemetry
}

export const SENTRY_FLUSH_TIMEOUT_MS = 4000;

// Non-Error tolerant: a raw string or object throw still prints a message,
// never the literal `undefined`.
export function describeError(e: unknown): { message: string; stack?: string } {
  if (e instanceof Error) return { message: e.message, stack: e.stack };
  if (typeof e === "string") return { message: e };
  const o = e as { message?: unknown; stack?: unknown } | null;
  if (o && typeof o.message === "string") {
    return {
      message: o.message,
      stack: typeof o.stack === "string" ? o.stack : undefined,
    };
  }
  let rendered: string;
  try {
    rendered = JSON.stringify(e);
  } catch {
    rendered = String(e);
  }
  return {
    message: `Unexpected non-Error value thrown: ${rendered ?? String(e)}`,
  };
}

export const defaultDeps: FailureReporterDeps = {
  log: (msg) => console.log(msg),
  logError: (msg) => console.error(msg),
  collectDebugInformation,
  captureException: (error) => {
    Sentry.captureException(error);
  },
  sendCommandErrorTelemetry: (command, errorType) =>
    sendTelemetry(command, { error: true, errorType }),
  flushTelemetry,
};

export async function reportFailure(
  f: CliFailure,
  deps: FailureReporterDeps,
): Promise<number> {
  const { message, error } = f;
  try {
    if (message) deps.log(message); // yargs validation text

    if (IsErrorType(error, "Usage")) {
      // not captured: cli-core's `beforeSend` drops "Usage Error" events
      // anyway (a user mistake, not a crash)
      deps.logError((error as Error).message); // one line, NO debug info
    } else if (IsErrorType(error, "External")) {
      // one clean line for the user, but still captured: `beforeSend`
      // keeps External errors
      deps.logError((error as Error).message); // one line, NO debug info
      deps.captureException(error);
    } else if (error !== undefined && error !== null) {
      const { message: m, stack } = describeError(error);
      deps.logError(m);
      if (stack) deps.logError(stack);
      deps.captureException(error);
      deps.logError("Collecting Debug Information...");
      try {
        const debugOutput = await deps.collectDebugInformation();
        deps.logError("Debug Information:");
        Object.entries(debugOutput).forEach(([key, value]) =>
          deps.log(`${key}: ${value === null ? "null" : value}`),
        );
      } catch (e) {
        deps.logError(
          `Could not collect debug information: ${describeError(e).message}`,
        );
      }
    }
  } catch (e) {
    deps.logError(`Error while reporting failure: ${describeError(e).message}`);
  }

  // The one place a failure that reaches the entrypoint is counted; synth
  // failures that exit inside cli-core count themselves and never get here.
  // A yargs validation failure carries a message but no error.
  try {
    await deps.sendCommandErrorTelemetry(
      Errors.getScope(),
      error === undefined || error === null ? "Usage" : commandErrorType(error),
    );
  } catch {
    /* never mask the original error */
  }
  try {
    await deps.flushTelemetry(SENTRY_FLUSH_TIMEOUT_MS);
  } catch {
    /* never mask the original error */
  }
  return 1;
}

export function runCli(
  y: yargs.Argv,
  deps: FailureReporterDeps = defaultDeps,
): Promise<void> {
  let failure: CliFailure | undefined;

  y.fail((message, error) => {
    // Must stay synchronous: yargs discards the return value, so an await here
    // races Node's unhandled-rejection reporter. y.exit does not exit under
    // .exitProcess(false); it sets hasOutput, which stops the handler running.
    y.exit(1, error as Error);
    if (!failure) failure = { message, error };
  });

  return (async () => {
    try {
      await y.parseAsync();
    } catch (error) {
      // Async handler rejections land here after .fail already recorded them;
      // synchronous handler throws bypass .fail entirely, so this is the only
      // place that catches those.
      if (!failure) failure = { message: null, error };
    }
    if (!failure) return; // success / --help / --version
    process.exit(await reportFailure(failure, deps));
  })().catch((e) => {
    // belt-and-braces: runCli itself must never reject
    console.error(
      `Fatal error in cdktn error handling: ${describeError(e).message}`,
    );
    process.exit(1);
  });
}
