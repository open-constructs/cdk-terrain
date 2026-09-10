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
  metrics: { count: jest.fn(), distribution: jest.fn() },
}));

jest.mock("ci-info", () => ({ isCI: false, name: null }));

// the capture setters call through so the gating cases below observe the
// real captured state, while init can still be asserted to perform them
jest.mock("@cdktn/commons", () => {
  const actual = jest.requireActual("@cdktn/commons");
  return {
    ...actual,
    collectDebugInformation: jest.fn().mockResolvedValue({}),
    setUsageTelemetryEnabled: jest.fn(actual.setUsageTelemetryEnabled),
  };
});

import * as Sentry from "@sentry/node";
import ciInfo from "ci-info";
import {
  Errors,
  isUsageTelemetryEnabled,
  resetCommandTelemetry,
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

describe("Sentry init hardening", () => {
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
    resetCommandTelemetry();
    Errors.setScope("unknown");
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

  it("starts a fresh trace so nothing seeded from SENTRY_TRACE/SENTRY_BAGGAGE propagates", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: true,
      sendUsageTelemetry: true,
    });

    await initializErrorReporting(jest.fn(), jest.fn());

    expect(mockScope.setPropagationContext).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      }),
    );
  });

  it("captures the usage decision while still in the user's cwd", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: false,
    });
    setInteractive(false);

    await initializErrorReporting();

    expect(setUsageTelemetryEnabled).toHaveBeenCalledWith(true);
  });

  it("reads and persists against an explicit project path, not the cwd", async () => {
    // init creates the project in a destination directory and initializes
    // reporting against it; the cwd may hold an unrelated (or no) cdktf.json
    const destination = path.join(workdir, "new-project");
    fs.mkdirpSync(destination);
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: true,
      sendUsageTelemetry: false,
    });
    fs.writeJsonSync(path.join(destination, "cdktf.json"), {
      sendCrashReports: false,
      sendUsageTelemetry: true,
    });
    setInteractive(true);
    const crashPrompt = jest.fn();
    const usagePrompt = jest.fn();

    await initializErrorReporting(crashPrompt, usagePrompt, destination);

    expect(crashPrompt).not.toHaveBeenCalled();
    expect(usagePrompt).not.toHaveBeenCalled();
    expect(setUsageTelemetryEnabled).toHaveBeenCalledWith(true);
    expect(isUsageTelemetryEnabled()).toBe(true);
    // usage-only consent: the client exists but drops error events
    await expect(initOptions().beforeSend({}, undefined)).resolves.toBeNull();
  });

  it("prompts into the explicit project path when its flags are unset", async () => {
    const destination = path.join(workdir, "new-project");
    fs.mkdirpSync(destination);
    fs.writeJsonSync(path.join(destination, "cdktf.json"), {});
    setInteractive(true);
    const crashPrompt = jest.fn().mockResolvedValue(true);
    const usagePrompt = jest.fn().mockResolvedValue(false);

    await initializErrorReporting(crashPrompt, usagePrompt, destination);

    expect(fs.readJsonSync(path.join(destination, "cdktf.json"))).toEqual({
      sendCrashReports: true,
      sendUsageTelemetry: false,
    });
    expect(fs.existsSync(path.join(workdir, "cdktf.json"))).toBe(false);
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

  describe("start-of-command metric", () => {
    const invokedCalls = () =>
      (Sentry.metrics.count as jest.Mock).mock.calls.filter(
        ([name]) => name === "cli.command.invoked",
      );

    it("counts the run once as cli.command.invoked under the command scope, after init", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "python",
        sendCrashReports: false,
      });
      setInteractive(false);
      Errors.setScope("deploy");

      await initializErrorReporting();
      // init runs get, which initializes reporting again
      await initializErrorReporting();

      expect(invokedCalls()).toHaveLength(1);
      expect(invokedCalls()[0][2]).toEqual(
        expect.objectContaining({
          attributes: expect.objectContaining({
            command: "deploy",
            language: "python",
          }),
        }),
      );
      expect(
        (Sentry.init as jest.Mock).mock.invocationCallOrder[0],
      ).toBeLessThan(
        (Sentry.metrics.count as jest.Mock).mock.invocationCallOrder[0],
      );
    });

    it("reads the language from the explicit project path", async () => {
      const destination = path.join(workdir, "new-project");
      fs.mkdirpSync(destination);
      fs.writeJsonSync(path.join(destination, "cdktf.json"), {
        language: "go",
        sendCrashReports: false,
      });
      setInteractive(false);
      Errors.setScope("init");

      await initializErrorReporting(undefined, undefined, destination);

      expect(invokedCalls()[0][2]).toEqual(
        expect.objectContaining({
          attributes: expect.objectContaining({
            command: "init",
            language: "go",
          }),
        }),
      );
    });

    it.each([
      ["usage telemetry declined", { sendUsageTelemetry: false }, {}],
      ["CHECKPOINT_DISABLE", {}, { CHECKPOINT_DISABLE: "1" }],
      ["no SENTRY_DSN", {}, { SENTRY_DSN: undefined }],
    ])("emits nothing when %s", async (_case, flags, env) => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendCrashReports: true,
        ...flags,
      });
      setInteractive(false);
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }

      await initializErrorReporting();

      expect(Sentry.metrics.count).not.toHaveBeenCalled();
    });
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
