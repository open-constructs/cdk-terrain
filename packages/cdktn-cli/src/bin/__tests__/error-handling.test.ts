// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import yargs, { Argv } from "yargs";
import { Errors } from "@cdktn/commons";
import {
  describeError,
  reportFailure,
  runCli,
  SENTRY_FLUSH_TIMEOUT_MS,
  FailureReporterDeps,
} from "../error-handling";

// Node schedules the unhandled-rejection bookkeeping for an orphaned promise
// at the end of the tick in which it is orphaned. Two setImmediate turns land
// strictly after that tick, which is what makes "was anything ever orphaned"
// a deterministic observation instead of a timing-dependent one.
async function flushMicroAndMacrotasks() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

function allLoggedText(deps: FailureReporterDeps): string[] {
  const log = deps.log as jest.Mock;
  const logError = deps.logError as jest.Mock;
  return [...log.mock.calls, ...logError.mock.calls].map((args) => args[0]);
}

function makeDeps(): FailureReporterDeps {
  return {
    log: jest.fn(),
    logError: jest.fn(),
    collectDebugInformation: jest
      .fn()
      .mockImplementation(
        () =>
          new Promise((resolve) => setImmediate(() => resolve({ node: "24" }))),
      ),
    captureException: jest.fn(),
    closeSentry: jest.fn().mockResolvedValue(true),
  };
}

// A fresh, isolated yargs instance per test: `yargs(args)` (the "yargs"
// package's singleton-factory form used by cdktn.ts itself) builds a brand
// new internal instance and returns it directly, so tests don't leak
// commands or `.fail()` handlers into one another.
function makeCli(args: string[], handlers: { ok?: jest.Mock } = {}) {
  return yargs(args)
    .exitProcess(false)
    .command(
      "boom",
      "throws an async Error",
      () => {},
      async () => {
        throw new Error("boom-message");
      },
    )
    .command(
      "rawboom",
      "throws an async raw string",
      () => {},
      async () => {
        throw "raw-string-message";
      },
    )
    .command(
      "syncboom",
      "throws synchronously",
      () => {},
      () => {
        throw new Error("sync-boom-message");
      },
    )
    .command(
      "usageboom",
      "throws a Usage error",
      () => {},
      // async, like real command handlers (e.g. deploy's), so this exercises
      // the same handler-rejection path as `boom`/`rawboom` rather than the
      // separate yargs-validation path exercised by `choice` below.
      async () => {
        throw Errors.Usage("bad-usage-message");
      },
    )
    .command(
      "externalboom",
      "throws an External error",
      () => {},
      async () => {
        throw Errors.External("bad-external-message");
      },
    )
    .command(
      "ok",
      "succeeds",
      () => {},
      () => {
        handlers.ok?.();
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
      () => {
        handlers.ok?.();
      },
    );
}

async function runAndCapture(
  args: string[],
  deps: FailureReporterDeps,
  handlers: { ok?: jest.Mock } = {},
) {
  const cli = makeCli(args, handlers);
  const exitSpy = jest
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const unhandledRejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandledRejections.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    await runCli(cli, deps);
  } finally {
    await flushMicroAndMacrotasks();
    process.off("unhandledRejection", onUnhandled);
  }

  // Capture everything the mock recorded BEFORE restoring it: mockRestore()
  // resets mock.calls (it's mockReset() + putting the real implementation
  // back), so reading exitSpy.mock.* after this point always reports empty.
  const exitCallCount = exitSpy.mock.calls.length;
  const lastCall = exitSpy.mock.calls[exitCallCount - 1];
  const exitCode = lastCall ? (lastCall[0] as number | undefined) : undefined;
  exitSpy.mockRestore();
  return { exitCode, exitCallCount, unhandledRejections };
}

describe("describeError", () => {
  it("handles a real Error", () => {
    const e = new Error("oops");
    const { message, stack } = describeError(e);
    expect(message).toBe("oops");
    expect(stack).toBe(e.stack);
  });

  it("handles a raw string throw", () => {
    expect(describeError("just a string")).toEqual({
      message: "just a string",
    });
  });

  it("handles an error-shaped plain object", () => {
    expect(describeError({ message: "shaped", stack: "at x" })).toEqual({
      message: "shaped",
      stack: "at x",
    });
  });

  it("handles an unrelated plain object", () => {
    const { message, stack } = describeError({ foo: "bar" });
    expect(message).toContain('{"foo":"bar"}');
    expect(stack).toBeUndefined();
  });

  it("handles null", () => {
    const { message } = describeError(null);
    expect(message).toContain("null");
  });

  it("handles a circular object without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { message } = describeError(circular);
    expect(typeof message).toBe("string");
    expect(message).toContain("Unexpected non-Error value thrown");
  });
});

describe("reportFailure", () => {
  it("prints Usage errors as a single line with no debug info, and never reports them to Sentry", async () => {
    const deps = makeDeps();
    const error = Errors.Usage("bad-usage-message");
    const code = await reportFailure({ message: null, error }, deps);

    expect(code).toBe(1);
    expect(deps.collectDebugInformation).not.toHaveBeenCalled();
    expect(allLoggedText(deps)).toEqual(["Usage Error: bad-usage-message"]);
    // beforeSend (cli-core's error-reporting.ts) drops "Usage Error" anyway;
    // don't even try to capture one.
    expect(deps.captureException).not.toHaveBeenCalled();
    expect(deps.closeSentry).toHaveBeenCalledWith(SENTRY_FLUSH_TIMEOUT_MS);
  });

  it("prints External errors as a single line with no debug info, but does report them to Sentry", async () => {
    const deps = makeDeps();
    const error = Errors.External("bad-external-message");
    const code = await reportFailure({ message: null, error }, deps);

    expect(code).toBe(1);
    expect(deps.collectDebugInformation).not.toHaveBeenCalled();
    expect(allLoggedText(deps)).toEqual([
      "External Error: bad-external-message",
    ]);
    expect(deps.captureException).toHaveBeenCalledWith(error);
    expect(deps.closeSentry).toHaveBeenCalledWith(SENTRY_FLUSH_TIMEOUT_MS);
  });

  it("reports a message + Error with message, stack, then debug info, and captures it for Sentry before flushing", async () => {
    const deps = makeDeps();
    const error = new Error("boom-message");
    const captureOrder: string[] = [];
    (deps.captureException as jest.Mock).mockImplementation(() =>
      captureOrder.push("capture"),
    );
    (deps.closeSentry as jest.Mock).mockImplementation(async () => {
      captureOrder.push("flush");
      return true;
    });
    const code = await reportFailure({ message: null, error }, deps);

    expect(code).toBe(1);
    const texts = allLoggedText(deps);
    expect(texts.filter((t) => t === "boom-message").length).toBe(1);
    expect(texts).toContain(error.stack);
    expect(texts).toContain("Collecting Debug Information...");
    expect(texts).toContain("Debug Information:");
    expect(deps.captureException).toHaveBeenCalledWith(error);
    // the capture must happen before the flush, or Sentry.close() has
    // nothing queued to send.
    expect(captureOrder).toEqual(["capture", "flush"]);
    expect(deps.closeSentry).toHaveBeenCalledWith(SENTRY_FLUSH_TIMEOUT_MS);
  });

  it("never prints the literal 'undefined' for a raw-string throw, and still captures it for Sentry", async () => {
    const deps = makeDeps();
    const code = await reportFailure(
      { message: null, error: "raw-string-message" },
      deps,
    );

    expect(code).toBe(1);
    const texts = allLoggedText(deps);
    expect(texts).toContain("raw-string-message");
    expect(texts).not.toContain("undefined");
    expect(deps.captureException).toHaveBeenCalledWith("raw-string-message");
  });

  it("reports a debug-collection failure without masking the original error", async () => {
    const deps = makeDeps();
    (deps.collectDebugInformation as jest.Mock).mockRejectedValue(
      new Error("debug collection exploded"),
    );
    const code = await reportFailure(
      { message: null, error: new Error("boom-message") },
      deps,
    );

    expect(code).toBe(1);
    const texts = allLoggedText(deps);
    expect(texts).toContain("boom-message");
    expect(
      texts.some((t) => t.includes("Could not collect debug information")),
    ).toBe(true);
    expect(deps.closeSentry).toHaveBeenCalledWith(SENTRY_FLUSH_TIMEOUT_MS);
  });

  it("still flushes Sentry even if captureException itself throws", async () => {
    const deps = makeDeps();
    (deps.captureException as jest.Mock).mockImplementation(() => {
      throw new Error("sentry client exploded");
    });
    const code = await reportFailure(
      { message: null, error: new Error("boom-message") },
      deps,
    );

    expect(code).toBe(1);
    expect(deps.closeSentry).toHaveBeenCalledWith(SENTRY_FLUSH_TIMEOUT_MS);
  });
});

describe("runCli", () => {
  it("reports an async Error thrown by a command handler exactly once, with no orphaned rejection", async () => {
    const deps = makeDeps();
    const { exitCode, exitCallCount, unhandledRejections } =
      await runAndCapture(["boom"], deps);

    expect(unhandledRejections).toEqual([]);
    expect(exitCode).toBe(1);
    expect(exitCallCount).toBe(1);
    const texts = allLoggedText(deps);
    expect(texts.filter((t) => t === "boom-message").length).toBe(1);
    expect(texts).toContain("Collecting Debug Information...");
    expect(texts).toContain("Debug Information:");
    expect(deps.captureException).toHaveBeenCalledTimes(1);
    expect(deps.closeSentry).toHaveBeenCalledWith(SENTRY_FLUSH_TIMEOUT_MS);
  });

  it("reports an async raw-string throw without ever printing 'undefined'", async () => {
    const deps = makeDeps();
    const { exitCode, unhandledRejections } = await runAndCapture(
      ["rawboom"],
      deps,
    );

    expect(unhandledRejections).toEqual([]);
    expect(exitCode).toBe(1);
    const texts = allLoggedText(deps);
    expect(texts).toContain("raw-string-message");
    expect(texts).not.toContain("undefined");
    expect(deps.captureException).toHaveBeenCalledWith("raw-string-message");
  });

  it("reports a synchronous handler throw", async () => {
    const deps = makeDeps();
    const { exitCode } = await runAndCapture(["syncboom"], deps);

    expect(exitCode).toBe(1);
    expect(allLoggedText(deps)).toContain("sync-boom-message");
    expect(deps.captureException).toHaveBeenCalledTimes(1);
  });

  it("prints Usage errors as one line, skips debug collection, and orphans no rejection", async () => {
    const deps = makeDeps();
    const { exitCode, unhandledRejections } = await runAndCapture(
      ["usageboom"],
      deps,
    );

    expect(unhandledRejections).toEqual([]);
    expect(exitCode).toBe(1);
    expect(allLoggedText(deps)).toEqual(["Usage Error: bad-usage-message"]);
    expect(deps.collectDebugInformation).not.toHaveBeenCalled();
    expect(deps.captureException).not.toHaveBeenCalled();
  });

  it("prints External errors as one line, skips debug collection, and orphans no rejection, but does report to Sentry", async () => {
    const deps = makeDeps();
    const { exitCode, exitCallCount, unhandledRejections } =
      await runAndCapture(["externalboom"], deps);

    expect(unhandledRejections).toEqual([]);
    expect(exitCode).toBe(1);
    expect(exitCallCount).toBe(1);
    expect(allLoggedText(deps)).toEqual([
      "External Error: bad-external-message",
    ]);
    expect(deps.collectDebugInformation).not.toHaveBeenCalled();
    expect(deps.captureException).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid choice before the command handler runs", async () => {
    const deps = makeDeps();
    const handler = jest.fn();
    const { exitCode } = await runAndCapture(
      ["choice", "--language=nope"],
      deps,
      { ok: handler },
    );

    expect(exitCode).toBe(1);
    expect(handler).not.toHaveBeenCalled();
    expect(allLoggedText(deps).some((t) => t.includes("Invalid values"))).toBe(
      true,
    );
    // yargs' own validation failures pass no `error` object, only a message,
    // so this never reaches the generic Error branch that captures for
    // Sentry (there'd be nothing usefully identifying to capture anyway).
    expect(deps.captureException).not.toHaveBeenCalled();
  });

  it("does not report a failure or exit on success", async () => {
    const deps = makeDeps();
    const handler = jest.fn();
    const { exitCode, exitCallCount, unhandledRejections } =
      await runAndCapture(["ok"], deps, { ok: handler });

    expect(handler).toHaveBeenCalled();
    expect(unhandledRejections).toEqual([]);
    expect(exitCallCount).toBe(0);
    expect(exitCode).toBeUndefined();
    expect(deps.log).not.toHaveBeenCalled();
    expect(deps.logError).not.toHaveBeenCalled();
  });

  it("does not report a failure or exit on --help", async () => {
    const deps = makeDeps();
    const { exitCallCount, unhandledRejections } = await runAndCapture(
      ["--help"],
      deps,
    );

    expect(unhandledRejections).toEqual([]);
    expect(exitCallCount).toBe(0);
    expect(deps.log).not.toHaveBeenCalled();
    expect(deps.logError).not.toHaveBeenCalled();
  });
});
