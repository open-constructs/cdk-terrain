// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import yargs, { Argv } from "yargs";
import * as Sentry from "@sentry/node";
import { Errors, collectDebugInformation } from "@cdktn/commons";
import { runCli } from "../error-handling";

jest.mock("@sentry/node", () => ({
  ...jest.requireActual("@sentry/node"),
  captureException: jest.fn(),
  flush: jest.fn(),
}));
// the real collector spawns terraform and every language toolchain
jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  collectDebugInformation: jest.fn(),
}));

const captureException = Sentry.captureException as jest.Mock;
const flush = Sentry.flush as jest.Mock;
const collectDebug = collectDebugInformation as jest.Mock;

const DEBUG_STDERR = ["Collecting Debug Information...", "Debug Information:"];
const DEBUG_STDOUT = ["node: 24"];
const choiceHandler = jest.fn();

// `yargs(args)` builds a fresh instance per test, so commands and `.fail()`
// handlers never leak between cases.
function makeCli(args: string[], thrown?: unknown) {
  return yargs(args)
    .exitProcess(false)
    .command(
      "boom",
      "rejects, like a real async handler",
      () => {},
      async () => {
        throw thrown;
      },
    )
    .command(
      "syncboom",
      "throws synchronously",
      () => {},
      () => {
        throw thrown;
      },
    )
    .command(
      "ok",
      "succeeds",
      () => {},
      () => {},
    )
    .command(
      "setcode",
      "succeeds after setting a non-zero exit code",
      () => {},
      () => {
        process.exitCode = 3;
      },
    )
    .command(
      "choice",
      "has an invalid-choice option",
      (cmdYargs: Argv) =>
        cmdYargs.option("language", {
          type: "string",
          choices: ["typescript", "python"],
        }),
      choiceHandler,
    );
}

async function run(args: string[], thrown?: unknown) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = jest
    .spyOn(console, "log")
    .mockImplementation((line) => void stdout.push(line));
  const errorSpy = jest
    .spyOn(console, "error")
    .mockImplementation((line) => void stderr.push(line));
  const exitSpy = jest
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);
  try {
    await runCli(makeCli(args, thrown));
    const lastExit = exitSpy.mock.calls[exitSpy.mock.calls.length - 1];
    return { stdout, stderr, exitCode: lastExit?.[0] };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

describe("runCli", () => {
  beforeEach(() => {
    captureException.mockReset();
    choiceHandler.mockReset();
    flush.mockReset().mockResolvedValue(true);
    collectDebug.mockReset().mockResolvedValue({ node: "24" });
  });

  const asyncError = new Error("boom-message");
  const syncError = new Error("sync-boom-message");
  const usageError = Errors.Usage("bad-usage-message");
  const externalError = Errors.External("bad-external-message");
  const errorShaped = { message: "shaped", stack: "at x" };
  const plainObject = { foo: "bar" };
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  it.each<{
    kind: string;
    args: string[];
    thrown?: unknown;
    stdout: unknown[];
    stderr: unknown[];
    captured: unknown[];
  }>([
    {
      kind: "an async Error with message, stack and debug information",
      args: ["boom"],
      thrown: asyncError,
      stdout: DEBUG_STDOUT,
      stderr: ["boom-message", asyncError.stack, ...DEBUG_STDERR],
      captured: [asyncError],
    },
    {
      kind: "a synchronous handler throw the same way",
      args: ["syncboom"],
      thrown: syncError,
      stdout: DEBUG_STDOUT,
      stderr: ["sync-boom-message", syncError.stack, ...DEBUG_STDERR],
      captured: [syncError],
    },
    {
      kind: "a raw string as its own message, with no stack line",
      args: ["boom"],
      thrown: "raw-string-message",
      stdout: DEBUG_STDOUT,
      stderr: ["raw-string-message", ...DEBUG_STDERR],
      captured: ["raw-string-message"],
    },
    {
      kind: "an error-shaped plain object by its message and stack",
      args: ["boom"],
      thrown: errorShaped,
      stdout: DEBUG_STDOUT,
      stderr: ["shaped", "at x", ...DEBUG_STDERR],
      captured: [errorShaped],
    },
    {
      kind: "an unrelated plain object as JSON",
      args: ["boom"],
      thrown: plainObject,
      stdout: DEBUG_STDOUT,
      stderr: [
        'Unexpected non-Error value thrown: {"foo":"bar"}',
        ...DEBUG_STDERR,
      ],
      captured: [plainObject],
    },
    {
      kind: "a circular object without failing to render it",
      args: ["boom"],
      thrown: circular,
      stdout: DEBUG_STDOUT,
      stderr: [
        "Unexpected non-Error value thrown: [object Object]",
        ...DEBUG_STDERR,
      ],
      captured: [circular],
    },
    {
      kind: "a Usage error as one line, uncaptured",
      args: ["boom"],
      thrown: usageError,
      stdout: [],
      stderr: ["Usage Error: bad-usage-message"],
      captured: [],
    },
    {
      kind: "an External error as one line, captured",
      args: ["boom"],
      thrown: externalError,
      stdout: [],
      stderr: ["External Error: bad-external-message"],
      captured: [externalError],
    },
    {
      kind: "an invalid choice with the yargs validation text, uncaptured",
      args: ["choice", "--language=nope"],
      stdout: [expect.stringContaining("Invalid values")],
      stderr: [],
      captured: [],
    },
  ])("reports $kind, then exits 1", async (row) => {
    const { stdout, stderr, exitCode } = await run(row.args, row.thrown);

    expect(stdout).toEqual(row.stdout);
    expect(stderr).toEqual(row.stderr);
    expect(captureException.mock.calls).toEqual(row.captured.map((e) => [e]));
    // a rejected argument must stop the command itself, not only fail the exit
    expect(choiceHandler).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
  });

  it("reports a debug-collection failure without masking the original error", async () => {
    collectDebug.mockRejectedValue(new Error("debug collection exploded"));

    const { stderr, exitCode } = await run(["boom"], asyncError);

    expect(stderr).toEqual([
      "boom-message",
      asyncError.stack,
      "Collecting Debug Information...",
      "Could not collect debug information: debug collection exploded",
    ]);
    expect(exitCode).toBe(1);
  });

  it("still prints the error and exits 1 when capturing it throws", async () => {
    captureException.mockImplementation(() => {
      throw new Error("sentry client exploded");
    });

    const { stderr, exitCode } = await run(["boom"], asyncError);

    expect(stderr).toEqual([
      "boom-message",
      asyncError.stack,
      "Error while reporting failure: sentry client exploded",
    ]);
    expect(exitCode).toBe(1);
  });

  it("keeps the exit code a handler already set", async () => {
    const originalExitCode = process.exitCode;
    try {
      const { exitCode } = await run(["setcode"]);

      expect(exitCode).toBe(3);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("still exits 0 when the flush itself rejects", async () => {
    flush.mockRejectedValue(new Error("transport exploded"));

    const { stderr, exitCode } = await run(["ok"]);

    expect(stderr).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("still exits 0 when the stdout reader closed early and the drain write gets EPIPE", async () => {
    // What Node does for `cdktn --help | head -1`: the write callback gets
    // EPIPE, then 'error' is emitted on the stream; unhandled, that throws.
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const errorListeners = process.stdout.listenerCount("error");
    const writeSpy = jest.spyOn(process.stdout, "write").mockImplementation(((
      ...args: unknown[]
    ) => {
      const cb = args.find((a) => typeof a === "function") as
        ((err?: Error) => void) | undefined;
      cb?.(epipe);
      process.nextTick(() => process.stdout.emit("error", epipe));
      return false;
    }) as never);
    try {
      const { exitCode } = await run(["ok"]);
      // lets the queued 'error' fire while the drain's listener may still be on
      await new Promise((r) => setImmediate(r));

      expect(exitCode).toBe(0);
    } finally {
      writeSpy.mockRestore();
    }
    // the drain's one-shot listener was consumed by the emitted 'error'
    expect(process.stdout.listenerCount("error")).toBe(errorListeners);
  });
});
