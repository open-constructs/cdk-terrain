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
      // cli-core's error-reporting.ts `beforeSend` drops "Usage Error"
      // exceptions on purpose (it's a user mistake, not a crash) - don't
      // even bother capturing one just to have it filtered out downstream.
      deps.logError((error as Error).message); // one line, NO debug info
    } else if (IsErrorType(error, "External")) {
      // Unlike Usage, External isn't filtered by `beforeSend`, so it's
      // reported: printing one clean line to the terminal doesn't mean the
      // failure is uninteresting to us, just that it's not the user's fault.
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
    // MUST stay synchronous: yargs discards this callback's return value
    // (yargs/build/lib/usage.js -> `fail(msg, err, self)`), so any await here
    // races Node's unhandled-rejection reporter. See error-handling.test.ts.
    //
    // With .exitProcess(false) this does NOT exit; it sets yargs' internal
    // `hasOutput` flag, which is what prevents the command handler from
    // running after a validation failure. Keep it, and keep it first.
    y.exit(1, error as Error);
    if (!failure) failure = { message, error };
  });

  return (async () => {
    try {
      await y.parseAsync();
    } catch (error) {
      // Async handler rejections reach here too (yargs rethrows out of parse()
      // after .fail ran) — `failure` is already set, so no double report.
      // Synchronous handler throws never reach .fail() at all in yargs 17;
      // this is the only place that catches them.
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
