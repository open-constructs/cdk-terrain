// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import yargs from "yargs";
import * as Sentry from "@sentry/node";
import { Errors, setUsageTelemetryEnabled } from "@cdktn/commons";

jest.mock("../helper/version-check", () => ({
  displayVersionMessage: jest.fn().mockResolvedValue(undefined),
}));

const mockRunWatch = jest.fn();
jest.mock("../ui/watch", () => ({
  runWatch: (...args: unknown[]) => mockRunWatch(...args),
}));

jest.mock("ci-info", () => ({ isCI: false, name: null }));

import { watch } from "../handlers";
import {
  defaultDeps,
  FailureReporterDeps,
  runCli,
  SENTRY_FLUSH_TIMEOUT_MS,
} from "../../error-handling";

// The guard runs after reporting is initialized, so its failure must reach
// the entrypoint's reporter like any other thrown error: one message, one
// cli.command.error, one flush, one exit.
describe("watch --auto-approve guard", () => {
  let workdir: string;
  const originalCwd = process.cwd();
  const originalEnv = {
    SENTRY_DSN: process.env.SENTRY_DSN,
    CHECKPOINT_DISABLE: process.env.CHECKPOINT_DISABLE,
  };
  let count: jest.SpyInstance;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-watch-"));
    process.chdir(workdir);
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      language: "typescript",
      app: "npx ts-node main.ts",
      sendCrashReports: false,
    });
    delete process.env.SENTRY_DSN;
    // the jest preset disables usage telemetry process-wide
    delete process.env.CHECKPOINT_DISABLE;
    setUsageTelemetryEnabled(undefined);
    count = jest.spyOn(Sentry.metrics, "count").mockImplementation(() => {});
  });

  afterEach(() => {
    count.mockRestore();
    setUsageTelemetryEnabled(undefined);
    Errors.setScope("unknown");
    process.chdir(originalCwd);
    fs.removeSync(workdir);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("yields one usage message, one cli.command.error and one flush before a single exit", async () => {
    const cli = yargs(["watch"])
      .exitProcess(false)
      .command(
        "watch",
        "watches",
        () => {},
        async (argv) => {
          Errors.setScope("watch");
          await watch({ ...argv, autoApprove: false });
        },
      );
    const deps: FailureReporterDeps = {
      log: jest.fn(),
      logError: jest.fn(),
      collectDebugInformation: jest.fn().mockResolvedValue({}),
      captureException: jest.fn(),
      // the real emitter: the metric below is the commons one, gated by the
      // decision initializErrorReporting captured
      sendCommandErrorTelemetry: defaultDeps.sendCommandErrorTelemetry,
      flushTelemetry: jest.fn().mockResolvedValue(undefined),
    };
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    let exitCalls: unknown[][];
    try {
      await runCli(cli, deps);
    } finally {
      // read before mockRestore(), which also resets the recorded calls
      exitCalls = exitSpy.mock.calls;
      exitSpy.mockRestore();
    }

    expect(mockRunWatch).not.toHaveBeenCalled();
    expect(exitCalls).toEqual([[1]]);
    expect(deps.logError).toHaveBeenCalledTimes(1);
    expect(deps.logError).toHaveBeenCalledWith(
      expect.stringContaining("--auto-approve flag must be set"),
    );
    expect(deps.captureException).not.toHaveBeenCalled();
    // the Usage factory counts a cli.error; the run itself is counted once
    const commandErrors = count.mock.calls.filter(
      ([name]) => name === "cli.command.error",
    );
    expect(commandErrors).toHaveLength(1);
    expect(commandErrors[0][2]).toEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({
          command: "watch",
          error_type: "Usage",
        }),
      }),
    );
    expect(deps.flushTelemetry).toHaveBeenCalledTimes(1);
    expect(deps.flushTelemetry).toHaveBeenCalledWith(SENTRY_FLUSH_TIMEOUT_MS);
    expect(count.mock.invocationCallOrder.at(-1)).toBeLessThan(
      (deps.flushTelemetry as jest.Mock).mock.invocationCallOrder[0],
    );
  });
});
