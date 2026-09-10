// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

const mockScope = {
  setUser: jest.fn(),
  setTag: jest.fn(),
  setTransactionName: jest.fn(),
  setPropagationContext: jest.fn(),
};
jest.mock("@sentry/node", () => ({
  init: jest.fn(),
  getCurrentScope: jest.fn(() => mockScope),
  setContext: jest.fn(),
  addBreadcrumb: jest.fn(), // the commons logger records every debug line
  flush: jest.fn().mockResolvedValue(true),
  close: jest.fn().mockResolvedValue(true),
}));

jest.mock("ci-info", () => ({ isCI: false, name: null }));

jest.mock("@cdktn/commons", () => {
  const actual = jest.requireActual("@cdktn/commons");
  return {
    ...actual,
    collectDebugInformation: jest.fn().mockResolvedValue({}),
  };
});

import * as Sentry from "@sentry/node";
import ciInfo from "ci-info";
import { initializErrorReporting } from "../lib/error-reporting";

// the ci-info mock above replaces the module with a plain mutable object,
// so tests can flip isCI; the published types declare it readonly
const ciInfoMock = ciInfo as unknown as { isCI: boolean };

const initOptions = () => (Sentry.init as jest.Mock).mock.calls.at(-1)![0];

describe("consent gating (initializErrorReporting)", () => {
  let workdir: string;
  const originalCwd = process.cwd();
  const originalEnv = {
    CI: process.env.CI,
    SENTRY_DSN: process.env.SENTRY_DSN,
  };
  const originalIsTTY = process.stdout.isTTY;

  const setInteractive = (interactive: boolean) => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: interactive,
      configurable: true,
    });
    if (interactive) {
      delete process.env.CI;
      ciInfoMock.isCI = false;
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-consent-"));
    process.chdir(workdir);
    delete process.env.CI;
    process.env.SENTRY_DSN = "https://public@example.invalid/1";
    ciInfoMock.isCI = false;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(workdir);
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("starts a fresh trace so nothing seeded from SENTRY_TRACE/SENTRY_BAGGAGE propagates", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: true,
      sendUsageTelemetry: true,
    });

    await initializErrorReporting(jest.fn());

    expect(mockScope.setPropagationContext).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      }),
    );
  });

  it("init options pin release, tracesSampleRate 0, a fixed environment, a fixed serverName and enableMetrics", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: true,
    });
    setInteractive(false);

    await initializErrorReporting();

    // fixed values are the production-side lock that neither the hostname
    // nor SENTRY_ENVIRONMENT reaches Sentry (the commons delivery tests set
    // their own init options)
    expect(initOptions()).toMatchObject({
      release: expect.stringMatching(/^cdktn-cli-/),
      tracesSampleRate: 0,
      environment: "production",
      serverName: "cdktn-cli",
      enableMetrics: true,
    });
  });
});
