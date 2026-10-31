// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as Sentry from "@sentry/node";

// Sentry is stubbed so reporting initializes and the run counts as invoked.
jest.mock("@sentry/node", () => ({
  init: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
  getCurrentScope: jest.fn(() => ({
    setUser: jest.fn(),
    setTag: jest.fn(),
    setPropagationContext: jest.fn(),
    setTransactionName: jest.fn(),
  })),
  addBreadcrumb: jest.fn(),
  metrics: { count: jest.fn(), distribution: jest.fn() },
}));
jest.mock("ci-info", () => ({ isCI: false, name: null }));

const mockInitLib = jest.fn();
jest.mock("@cdktn/cli-core", () => ({
  ...jest.requireActual("@cdktn/cli-core"),
  init: (...args: unknown[]) => mockInitLib(...args),
}));

jest.mock("../terraform-check", () => ({
  getTerraformVersion: jest.fn().mockResolvedValue(undefined),
  terraformCheck: jest.fn().mockResolvedValue(undefined),
}));

import {
  Errors,
  isUsageTelemetryEnabled,
  resetCommandTelemetry,
  setUsageTelemetryEnabled,
} from "@cdktn/commons";
import { runInit } from "../init";

describe("runInit reporting", () => {
  let cwd: string;
  let destination: string;
  const originalCwd = process.cwd();
  const originalEnv = {
    SENTRY_DSN: process.env.SENTRY_DSN,
    CHECKPOINT_DISABLE: process.env.CHECKPOINT_DISABLE,
  };
  const count = Sentry.metrics.count as jest.Mock;

  const init = () =>
    runInit({
      destination,
      local: true,
      silent: true,
      nonInteractive: true,
      template: "typescript",
      projectName: "test",
      projectDescription: "test",
      fromTerraformProject: "no",
      enableCrashReporting: false,
      enableUsageTelemetry: true,
      providers: ["aws"],
    });

  beforeEach(() => {
    count.mockClear();
    // the directory init runs from opts out; the project it creates opts in
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-init-cwd-"));
    fs.writeJsonSync(path.join(cwd, "cdktf.json"), {
      language: "python",
      app: "python main.py",
      sendCrashReports: false,
      sendUsageTelemetry: false,
    });
    process.chdir(cwd);
    destination = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-init-"));
    mockInitLib.mockImplementation(async () => {
      fs.writeJsonSync(path.join(destination, "cdktf.json"), {
        language: "typescript",
        app: "npx ts-node main.ts",
        sendCrashReports: false,
        sendUsageTelemetry: true,
      });
      return false;
    });
    process.env.SENTRY_DSN = "https://public@example.invalid/1";
    // the jest preset disables usage telemetry process-wide
    delete process.env.CHECKPOINT_DISABLE;
    setUsageTelemetryEnabled(undefined);
    Errors.setScope("init");
  });

  afterEach(() => {
    setUsageTelemetryEnabled(undefined);
    resetCommandTelemetry();
    Errors.setScope("unknown");
    process.chdir(originalCwd);
    fs.removeSync(cwd);
    fs.removeSync(destination);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("counts the run under the consent and language of the project it created", async () => {
    await init();

    expect(count.mock.calls).toEqual([
      [
        "cli.command.invoked",
        1,
        {
          attributes: expect.objectContaining({
            command: "init",
            language: "typescript",
          }),
        },
      ],
    ]);
  });

  it("leaves an already captured decision alone (convert drives init in a throwaway project)", async () => {
    setUsageTelemetryEnabled(false);

    await init();

    expect(isUsageTelemetryEnabled()).toBe(false);
    expect(count).not.toHaveBeenCalled();
  });
});
