// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as Sentry from "@sentry/node";
import {
  Errors,
  resetCommandTelemetry,
  setUsageTelemetryEnabled,
} from "@cdktn/commons";

// Sentry is stubbed so reporting initializes and the run counts as invoked.
jest.mock("@sentry/node", () => ({
  init: jest.fn(),
  getCurrentScope: jest.fn(() => ({
    setUser: jest.fn(),
    setTag: jest.fn(),
    setPropagationContext: jest.fn(),
    setTransactionName: jest.fn(),
  })),
  addBreadcrumb: jest.fn(),
  metrics: { count: jest.fn(), distribution: jest.fn() },
}));
jest.mock("../helper/version-check", () => ({
  displayVersionMessage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../helper/terraform-check", () => ({
  terraformCheck: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../helper/check-environment", () => ({
  ...jest.requireActual("../helper/check-environment"),
  checkEnvironment: jest.fn().mockResolvedValue(undefined),
  verifySimilarLibraryVersion: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../ui/watch", () => ({
  runWatch: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../ui/list", () => ({
  runList: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../ui/output", () => ({
  runOutput: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("ci-info", () => ({ isCI: false, name: null }));

import { get, list, output, watch } from "../handlers";

// A run that ends without an error counts exactly one cli.command.completed
// under its own command, whatever nested operation it drove.
describe("completion metric of handlers without an own emitter", () => {
  let workdir: string;
  const originalCwd = process.cwd();
  const originalEnv = {
    SENTRY_DSN: process.env.SENTRY_DSN,
    CHECKPOINT_DISABLE: process.env.CHECKPOINT_DISABLE,
  };
  const count = Sentry.metrics.count as jest.Mock;

  const metricCalls = (name: string) =>
    count.mock.calls.filter(([metric]) => metric === name);

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-completion-"));
    process.chdir(workdir);
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      language: "typescript",
      app: "npx ts-node main.ts",
      sendCrashReports: false,
    });
    process.env.SENTRY_DSN = "https://public@example.invalid/1";
    // the jest preset disables usage telemetry process-wide
    delete process.env.CHECKPOINT_DISABLE;
    setUsageTelemetryEnabled(undefined);
    count.mockClear();
  });

  afterEach(() => {
    setUsageTelemetryEnabled(undefined);
    resetCommandTelemetry();
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

  it.each<[string, () => Promise<void>]>([
    ["watch", () => watch({ autoApprove: true })],
    ["list", () => list({})],
    ["output", () => output({})],
    // no providers or modules: get returns before any generation
    [
      "get",
      () =>
        get({ output: ".gen", language: "typescript" as any, parallelism: 1 }),
    ],
  ])("%s counts invoked and completed once each", async (command, run) => {
    Errors.setScope(command);

    await run();

    for (const metric of ["cli.command.invoked", "cli.command.completed"]) {
      expect(metricCalls(metric)).toEqual([
        [
          metric,
          1,
          {
            attributes: expect.objectContaining({
              command,
              language: "typescript",
            }),
          },
        ],
      ]);
    }
    expect(metricCalls("cli.command.error")).toHaveLength(0);
  });
});
