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
    setPropagationContext: jest.fn(),
  })),
  setContext: jest.fn(),
  addBreadcrumb: jest.fn(), // the commons logger records every debug line
  flush: jest.fn().mockResolvedValue(true),
  close: jest.fn().mockResolvedValue(true),
}));

jest.mock("ci-info", () => ({ isCI: false, name: null }));

jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  collectDebugInformation: jest.fn().mockResolvedValue({}),
}));

import * as Sentry from "@sentry/node";
import ciInfo from "ci-info";
import {
  isUsageTelemetryEnabled,
  setProjectTargetAttributes,
  setUsageTelemetryEnabled,
} from "@cdktn/commons";
import {
  initializErrorReporting,
  shouldReportCrash,
  persistSendUsageTelemetryDecision,
} from "../lib/error-reporting";

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
    CHECKPOINT_DISABLE: process.env.CHECKPOINT_DISABLE,
    SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,
    SENTRY_TRACE: process.env.SENTRY_TRACE,
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
    delete process.env.CHECKPOINT_DISABLE;
    process.env.SENTRY_DSN = "https://public@example.invalid/1";
    ciInfoMock.isCI = false;
  });

  afterEach(() => {
    setUsageTelemetryEnabled(undefined);
    setProjectTargetAttributes(undefined);
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

  // Every condition that makes prompting impossible falls through to the
  // non-interactive defaults: no prompt, nothing persisted, usage default-on.
  it.each([
    ["no TTY", () => setInteractive(false), true],
    [
      "TTY but ciInfo.isCI",
      () => {
        setInteractive(true);
        ciInfoMock.isCI = true;
      },
      true,
    ],
    [
      "TTY but CI env var",
      () => {
        setInteractive(true);
        process.env.CI = "true";
      },
      true,
    ],
    [
      "TTY but no cdktf.json (no-project command)",
      () => setInteractive(true),
      false,
    ],
  ])(
    "usage unset, %s -> no prompt, nothing persisted, default-on init",
    async (_case, arrange, hasProject) => {
      if (hasProject) {
        fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
          sendCrashReports: false,
        });
      }
      arrange();
      const crashPrompt = jest.fn();
      const usagePrompt = jest.fn();

      await initializErrorReporting(crashPrompt, usagePrompt);

      expect(crashPrompt).not.toHaveBeenCalled();
      expect(usagePrompt).not.toHaveBeenCalled();
      if (hasProject) {
        expect(
          fs.readJsonSync(path.join(workdir, "cdktf.json")).sendUsageTelemetry,
        ).toBeUndefined();
      } else {
        expect(fs.existsSync(path.join(workdir, "cdktf.json"))).toBe(false);
      }
      expect(Sentry.init).toHaveBeenCalledTimes(1);
    },
  );

  it("pins environment and server name so SENTRY_* env vars never reach the SDK options", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: true,
      sendUsageTelemetry: true,
    });
    process.env.SENTRY_ENVIRONMENT = "LEAK-ENV-SENTRY";
    process.env.SENTRY_TRACE =
      "0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-1";

    await initializErrorReporting(jest.fn(), jest.fn());

    // the only production-side lock that the hostname never reaches Sentry
    // (the commons delivery tests set serverName themselves)
    expect(initOptions()).toMatchObject({
      environment: "production",
      serverName: "cdktn-cli",
    });
    const scope = (Sentry.getCurrentScope as jest.Mock).mock.results[0].value;
    expect(scope.setPropagationContext).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: expect.not.stringContaining("0af7651916cd43dd"),
      }),
    );
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

  // The resolved decision is captured for the whole run: commands that chdir
  // into another project (convert) must not re-read that project's flag.
  it.each([
    [
      "CHECKPOINT_DISABLE",
      { CHECKPOINT_DISABLE: "1" },
      { sendUsageTelemetry: true },
      false,
    ],
    ["flag unset, no TTY", {}, { sendUsageTelemetry: false }, true],
  ])(
    "captures the usage decision at init (%s) for every later project directory",
    async (_case, env, otherProject, expected) => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendCrashReports: false,
      });
      setInteractive(false);
      Object.assign(process.env, env);
      const other = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-other-"));
      fs.writeJsonSync(path.join(other, "cdktf.json"), otherProject);

      try {
        await initializErrorReporting();
        delete process.env.CHECKPOINT_DISABLE;

        expect(isUsageTelemetryEnabled(other)).toBe(expected);
      } finally {
        fs.removeSync(other);
      }
    },
  );

  it("init options pin release, tracesSampleRate 0 and a fixed serverName", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: true,
    });
    setInteractive(false);

    await initializErrorReporting();

    const options = initOptions();
    expect(options.release).toMatch(/^cdktn-cli-/);
    expect(options.tracesSampleRate).toBe(0);
    expect(options.serverName).toBe("cdktn-cli");
  });

  describe("beforeSend", () => {
    const boom = { message: "boom" };

    it("passes error events through when crash reporting is consented, even under CHECKPOINT_DISABLE", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendCrashReports: true,
      });
      setInteractive(false);
      process.env.CHECKPOINT_DISABLE = "1";

      await initializErrorReporting();

      expect(
        await initOptions().beforeSend(boom, {
          originalException: new Error("boom"),
        }),
      ).toBe(boom);
    });

    it("drops error events on a usage-only init (crash declined)", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendCrashReports: false,
        sendUsageTelemetry: true,
      });
      setInteractive(false);

      await initializErrorReporting();

      expect(Sentry.init).toHaveBeenCalledTimes(1);
      expect(
        await initOptions().beforeSend(boom, {
          originalException: new Error("boom"),
        }),
      ).toBeNull();
    });

    it("still drops Usage Errors when crash reporting is enabled", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendCrashReports: true,
      });
      setInteractive(false);

      await initializErrorReporting();

      expect(
        await initOptions().beforeSend(
          { message: "x" },
          { originalException: new Error("Usage Error: bad input") },
        ),
      ).toBeNull();
    });
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
    // undefined, not false, for an absent flag: that is what triggers the
    // crash-consent prompt
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
