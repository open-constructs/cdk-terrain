// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

jest.mock("@sentry/node", () => ({
  init: jest.fn(),
  getCurrentScope: jest.fn(() => ({
    setUser: jest.fn(),
    setTag: jest.fn(),
    setTransactionName: jest.fn(),
  })),
  setContext: jest.fn(),
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
  close: jest.fn().mockResolvedValue(true),
  metrics: {
    count: jest.fn(),
    distribution: jest.fn(),
    gauge: jest.fn(),
  },
}));

jest.mock("ci-info", () => ({ isCI: false, name: null }));

jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  collectDebugInformation: jest.fn().mockResolvedValue({}),
}));

import * as Sentry from "@sentry/node";
import {
  initializErrorReporting,
  shouldReportCrash,
  persistSendUsageTelemetryDecision,
} from "../lib/error-reporting";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ciInfo = require("ci-info");

describe("consent gating (initializErrorReporting)", () => {
  let workdir: string;
  const originalCwd = process.cwd();
  const originalEnv = {
    CI: process.env.CI,
    SENTRY_DSN: process.env.SENTRY_DSN,
    CHECKPOINT_DISABLE: process.env.CHECKPOINT_DISABLE,
  };
  const originalIsTTY = process.stdout.isTTY;

  const setInteractive = (interactive: boolean) => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: interactive,
      configurable: true,
    });
    if (interactive) {
      delete process.env.CI;
      ciInfo.isCI = false;
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-consent-"));
    process.chdir(workdir);
    delete process.env.CI;
    delete process.env.CHECKPOINT_DISABLE;
    process.env.SENTRY_DSN = "https://public@example.invalid/1";
    ciInfo.isCI = false;
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

  it("upgrade path: crash set, usage unset, interactive -> prompts ONCE for usage only and persists", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: true,
    });
    setInteractive(true);
    const crashPrompt = jest.fn().mockResolvedValue(true);
    const usagePrompt = jest.fn().mockResolvedValue(true);

    await initializErrorReporting(crashPrompt, usagePrompt);

    expect(crashPrompt).not.toHaveBeenCalled();
    expect(usagePrompt).toHaveBeenCalledTimes(1);
    expect(fs.readJsonSync(path.join(workdir, "cdktf.json"))).toMatchObject({
      sendCrashReports: true,
      sendUsageTelemetry: true,
    });
    expect(Sentry.init).toHaveBeenCalledTimes(1);
  });

  it("both unset, interactive -> prompts for each flag and persists both", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {});
    setInteractive(true);
    const crashPrompt = jest.fn().mockResolvedValue(false);
    const usagePrompt = jest.fn().mockResolvedValue(false);

    await initializErrorReporting(crashPrompt, usagePrompt);

    expect(crashPrompt).toHaveBeenCalledTimes(1);
    expect(usagePrompt).toHaveBeenCalledTimes(1);
    expect(fs.readJsonSync(path.join(workdir, "cdktf.json"))).toMatchObject({
      sendCrashReports: false,
      sendUsageTelemetry: false,
    });
    // both declined -> no Sentry at all
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("usage unset, non-interactive (no TTY) -> no prompt, usage default-on initializes Sentry", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: false,
    });
    setInteractive(false);
    const crashPrompt = jest.fn();
    const usagePrompt = jest.fn();

    await initializErrorReporting(crashPrompt, usagePrompt);

    expect(crashPrompt).not.toHaveBeenCalled();
    expect(usagePrompt).not.toHaveBeenCalled();
    // nothing persisted without consent
    expect(
      fs.readJsonSync(path.join(workdir, "cdktf.json")).sendUsageTelemetry,
    ).toBeUndefined();
    expect(Sentry.init).toHaveBeenCalledTimes(1);
  });

  it("usage unset, CI (TTY but ciInfo.isCI) -> no prompt, default-on init", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {});
    setInteractive(true);
    ciInfo.isCI = true;
    const usagePrompt = jest.fn();

    await initializErrorReporting(jest.fn(), usagePrompt);

    expect(usagePrompt).not.toHaveBeenCalled();
    expect(Sentry.init).toHaveBeenCalledTimes(1);
  });

  it("CHECKPOINT_DISABLE -> no usage prompt, no init when crash is off", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: false,
    });
    setInteractive(true);
    process.env.CHECKPOINT_DISABLE = "1";
    const usagePrompt = jest.fn();

    await initializErrorReporting(jest.fn(), usagePrompt);

    expect(usagePrompt).not.toHaveBeenCalled();
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("CHECKPOINT_DISABLE does NOT affect crash reporting", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: true,
    });
    setInteractive(false);
    process.env.CHECKPOINT_DISABLE = "1";

    await initializErrorReporting();

    expect(Sentry.init).toHaveBeenCalledTimes(1);
    // crash consent present -> error events pass beforeSend
    const beforeSend = (Sentry.init as jest.Mock).mock.calls[0][0].beforeSend;
    const event = { message: "boom" };
    expect(
      await beforeSend(event, { originalException: new Error("boom") }),
    ).toBe(event);
  });

  it("explicit sendUsageTelemetry: false + crash off -> Sentry never initialized", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: false,
      sendUsageTelemetry: false,
    });
    setInteractive(false);

    await initializErrorReporting();

    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("usage-only init (crash declined) drops error events in beforeSend", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: false,
      sendUsageTelemetry: true,
    });
    setInteractive(false);

    await initializErrorReporting();

    expect(Sentry.init).toHaveBeenCalledTimes(1);
    const beforeSend = (Sentry.init as jest.Mock).mock.calls[0][0].beforeSend;
    expect(
      await beforeSend(
        { message: "boom" },
        { originalException: new Error("boom") },
      ),
    ).toBeNull();
  });

  it("crash-enabled beforeSend still drops Usage Errors", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: true,
    });
    setInteractive(false);

    await initializErrorReporting();

    const beforeSend = (Sentry.init as jest.Mock).mock.calls[0][0].beforeSend;
    expect(
      await beforeSend(
        { message: "x" },
        { originalException: new Error("Usage Error: bad input") },
      ),
    ).toBeNull();
  });

  it("no SENTRY_DSN -> no init even with consent", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: true,
      sendUsageTelemetry: true,
    });
    setInteractive(false);
    delete process.env.SENTRY_DSN;

    await initializErrorReporting();

    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("no cdktf.json (no-project command) -> no prompt, usage default-on init, nothing persisted", async () => {
    setInteractive(true);
    const crashPrompt = jest.fn();
    const usagePrompt = jest.fn();

    await initializErrorReporting(crashPrompt, usagePrompt);

    expect(crashPrompt).not.toHaveBeenCalled();
    expect(usagePrompt).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(workdir, "cdktf.json"))).toBe(false);
    expect(Sentry.init).toHaveBeenCalledTimes(1);
  });

  it("init options pin release, tracesSampleRate 0 and a fixed serverName", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: true,
    });
    setInteractive(false);

    await initializErrorReporting();

    const options = (Sentry.init as jest.Mock).mock.calls[0][0];
    expect(options.release).toMatch(/^cdktn-cli-/);
    expect(options.tracesSampleRate).toBe(0);
    expect(options.serverName).toBe("cdktn-cli");
  });
});

describe("shouldReportCrash tri-state", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-crash-"));
  });

  afterEach(() => {
    fs.removeSync(workdir);
  });

  it.each([
    [{ sendCrashReports: true }, true],
    [{ sendCrashReports: false }, false],
    [{ sendCrashReports: "true" }, true],
    [{ sendCrashReports: "false" }, false],
    [{}, undefined],
  ])("reads %j as %p", (config, expected) => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), config);
    expect(shouldReportCrash(workdir)).toBe(expected);
  });

  it("returns false outside a project (missing cdktf.json)", () => {
    expect(shouldReportCrash(workdir)).toBe(false);
  });
});

describe("persistSendUsageTelemetryDecision", () => {
  it("writes the decision without clobbering other keys", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-persist-"));
    try {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
        sendCrashReports: true,
      });
      persistSendUsageTelemetryDecision(false, workdir);
      expect(fs.readJsonSync(path.join(workdir, "cdktf.json"))).toEqual({
        language: "typescript",
        sendCrashReports: true,
        sendUsageTelemetry: false,
      });
    } finally {
      fs.removeSync(workdir);
    }
  });
});
