// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as yargs from "yargs";
import * as Sentry from "@sentry/node";
import { IsErrorType, collectDebugInformation } from "@cdktn/commons";

type CliFailure = { message?: string | null; error?: unknown };

const SENTRY_FLUSH_TIMEOUT_MS = 4000;

// yargs' hard-coded flag for a shell completion request (`cdktn diff <TAB>`
// runs `cdktn --get-yargs-completions cdktn diff ""`); its parsed value is
// whatever word follows it, so only presence counts (as yargs itself checks).
const YARGS_COMPLETION_KEY = "get-yargs-completions";

// a thrown string or plain object still yields a message, never `undefined`
function describeError(e: unknown): { message: string; stack?: string } {
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

async function reportFailure({ message, error }: CliFailure): Promise<number> {
  try {
    if (message) console.log(message); // yargs validation text

    if (IsErrorType(error, "Usage")) {
      // a user mistake, not a crash: not captured
      console.error((error as Error).message);
    } else if (IsErrorType(error, "External")) {
      // captured, but printed without stack or debug information
      console.error((error as Error).message);
      Sentry.captureException(error);
    } else if (error !== undefined && error !== null) {
      const { message: m, stack } = describeError(error);
      console.error(m);
      if (stack) console.error(stack);
      Sentry.captureException(error);
      console.error("Collecting Debug Information...");
      try {
        const debugOutput = await collectDebugInformation();
        console.error("Debug Information:");
        Object.entries(debugOutput).forEach(([key, value]) =>
          console.log(`${key}: ${value === null ? "null" : value}`),
        );
      } catch (e) {
        console.error(
          `Could not collect debug information: ${describeError(e).message}`,
        );
      }
    }
  } catch (e) {
    console.error(`Error while reporting failure: ${describeError(e).message}`);
  }

  try {
    await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS);
  } catch {
    /* never mask the original error */
  }
  return 1;
}

// process.exit drops stdio writes still queued behind a slow pipe reader (a
// full 64 KiB pipe truncates `cdktn convert | less` on macOS); a zero-length
// write's callback runs only once everything queued before it has gone out.
async function drainStdio(): Promise<void> {
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          // A reader that already closed (`cdktn --help | head -1`) reports
          // EPIPE to the callback and then emits 'error'; console.log swallows
          // it, this listener does the same (kept only while an error is due).
          const onError = () => resolve();
          stream.once("error", onError);
          stream.write("", (err) => {
            if (!err) stream.off("error", onError);
            resolve();
          });
        }),
    ),
  );
}

export function runCli(y: yargs.Argv): Promise<void> {
  let failure: CliFailure | undefined;

  y.fail((message, error) => {
    // Must stay synchronous: yargs discards the return value, so an await here
    // races Node's unhandled-rejection reporter. y.exit does not exit under
    // .exitProcess(false); it sets hasOutput, which stops the handler running.
    y.exit(1, error as Error);
    if (!failure) failure = { message, error };
  });

  return (async () => {
    let completionRequest = false;
    try {
      const argv = await y.parseAsync();
      completionRequest = YARGS_COMPLETION_KEY in argv;
    } catch (error) {
      // Async handler rejections land here after .fail already recorded them;
      // synchronous handler throws bypass .fail entirely, so this is the only
      // place that catches those.
      if (!failure) failure = { message: null, error };
    }
    if (failure) {
      process.exit(await reportFailure(failure));
    } else if (completionRequest) {
      // yargs does not await an asynchronous completion callback (cdktn.ts
      // reads the manifest), so it prints after parseAsync resolved: exiting
      // here would cut it off, and no handler ran, so nothing needs a flush.
      return;
    } else {
      // success / --help / --version: Sentry buffers asynchronously, so flush
      // (bounded) and exit explicitly, or an unresponsive ingest endpoint
      // keeps the transport socket and the process alive.
      try {
        await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS);
      } catch {
        /* never block the exit */
      }
      await drainStdio();
      process.exit(process.exitCode ?? 0);
    }
  })().catch((e) => {
    // belt-and-braces: runCli itself must never reject
    console.error(
      `Fatal error in cdktn error handling: ${describeError(e).message}`,
    );
    process.exit(1);
  });
}
