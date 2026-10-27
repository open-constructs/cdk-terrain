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

jest.mock("@cdktn/commons", () => {
  const actual = jest.requireActual("@cdktn/commons");
  return {
    ...actual,
    collectDebugInformation: jest.fn().mockResolvedValue({}),
  };
});

import * as Sentry from "@sentry/node";
import ciInfo from "ci-info";
import {
  collectDebugInformation,
  Errors,
  isUsageTelemetryEnabled,
  resetCommandTelemetry,
  seedTerraformCliProbeForTests,
  setProjectTargetAttributes,
  setUsageTelemetryEnabled,
} from "@cdktn/commons";
import {
  initializErrorReporting,
  shouldReportCrash,
} from "../lib/error-reporting";

// the ci-info mock above replaces the module with a plain mutable object,
// so tests can flip isCI; the published types declare it readonly
const ciInfoMock = ciInfo as unknown as { isCI: boolean };

const initOptions = () => (Sentry.init as jest.Mock).mock.calls.at(-1)![0];

const setInteractive = (interactive: boolean) => {
  Object.defineProperty(process.stdout, "isTTY", {
    value: interactive,
    configurable: true,
  });
  Object.defineProperty(process.stdin, "isTTY", {
    value: interactive,
    configurable: true,
  });
  if (interactive) {
    delete process.env.CI;
    ciInfoMock.isCI = false;
  }
};

let workdir: string;

// Shared by every describe below: a temp project as cwd, an interactive-
// capable terminal and a DSN, restored after each case.
function useReportingFixture() {
  const originalCwd = process.cwd();
  const originalEnv = {
    CI: process.env.CI,
    SENTRY_DSN: process.env.SENTRY_DSN,
    CHECKPOINT_DISABLE: process.env.CHECKPOINT_DISABLE,
  };
  const originalIsTTY = process.stdout.isTTY;
  const originalStdinIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    jest.clearAllMocks();
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-consent-"));
    process.chdir(workdir);
    delete process.env.CI;
    delete process.env.CHECKPOINT_DISABLE;
    process.env.SENTRY_DSN = "https://public@example.invalid/1";
    ciInfoMock.isCI = false;
    // the start-of-command metric stamps the binary; keep it off the machine
    seedTerraformCliProbeForTests(Promise.resolve("Terraform v1.9.0\n"));
  });

  afterEach(() => {
    setUsageTelemetryEnabled(undefined);
    resetCommandTelemetry();
    Errors.setScope("unknown");
    setProjectTargetAttributes(undefined);
    seedTerraformCliProbeForTests();
    process.chdir(originalCwd);
    fs.removeSync(workdir);
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdinIsTTY,
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
}

describe("Sentry init hardening", () => {
  useReportingFixture();

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
  it("logs a failed background environment collection instead of rejecting", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: true,
    });
    setInteractive(false);
    (collectDebugInformation as jest.Mock).mockRejectedValueOnce(
      new Error("spawn npm ENOENT"),
    );

    await initializErrorReporting();
    // the collection is not awaited; let its chain settle
    await new Promise(setImmediate);

    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Could not collect environment information: Error: spawn npm ENOENT",
      }),
    );
    expect(Sentry.setContext).not.toHaveBeenCalled();
  });
});

describe("consent gating (initializErrorReporting)", () => {
  useReportingFixture();

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
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  // Every condition that makes prompting impossible falls through to the
  // non-interactive defaults: neither prompt, nothing persisted, usage on.
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
      "stdin TTY but stdout redirected",
      () => {
        setInteractive(true);
        Object.defineProperty(process.stdout, "isTTY", {
          value: undefined,
          configurable: true,
        });
      },
      true,
    ],
    [
      "stdout TTY but stdin piped",
      () => {
        setInteractive(true);
        Object.defineProperty(process.stdin, "isTTY", {
          value: undefined,
          configurable: true,
        });
      },
      true,
    ],
    [
      "TTY but no cdktf.json (no-project command)",
      () => setInteractive(true),
      false,
    ],
  ])(
    "both flags unset, %s -> no prompt, nothing persisted, default-on init",
    async (_case, arrange, hasProject) => {
      if (hasProject) {
        fs.writeJsonSync(path.join(workdir, "cdktf.json"), {});
      }
      arrange();
      const crashPrompt = jest.fn();
      const usagePrompt = jest.fn();

      await initializErrorReporting(crashPrompt, usagePrompt);

      expect(crashPrompt).not.toHaveBeenCalled();
      expect(usagePrompt).not.toHaveBeenCalled();
      if (hasProject) {
        const persisted = fs.readJsonSync(path.join(workdir, "cdktf.json"));
        expect(persisted.sendCrashReports).toBeUndefined();
        expect(persisted.sendUsageTelemetry).toBeUndefined();
      } else {
        expect(fs.existsSync(path.join(workdir, "cdktf.json"))).toBe(false);
      }
      expect(Sentry.init).toHaveBeenCalledTimes(1);
    },
  );
  it("reads the consent flags of an explicit project path, not the cwd", async () => {
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
  it("malformed flags, non-interactive -> usage on, crash off", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: null,
      sendUsageTelemetry: "yes",
    });
    setInteractive(false);

    await initializErrorReporting();

    expect(isUsageTelemetryEnabled()).toBe(true);
    await expect(initOptions().beforeSend({}, undefined)).resolves.toBeNull();
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

  // A command can run another one inside a different project (convert runs
  // init and get in a temporary one): the first project decides for the run.
  describe("a later init against another project", () => {
    let other: string;

    const initRootThenOther = async (
      root: Record<string, unknown>,
      nested: Record<string, unknown>,
      prompt?: jest.Mock,
    ) => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), root);
      fs.writeJsonSync(path.join(other, "cdktf.json"), nested);
      Errors.setScope("convert");
      await initializErrorReporting();
      await initializErrorReporting(prompt, prompt, other);
    };

    beforeEach(() => {
      other = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-other-"));
      setInteractive(false);
    });

    afterEach(() => {
      fs.removeSync(other);
    });

    it("opted in, then a project that opts out -> usage stays on and crashes are still reported", async () => {
      await initRootThenOther(
        { sendCrashReports: true, sendUsageTelemetry: true },
        { sendCrashReports: false, sendUsageTelemetry: false },
      );

      expect(isUsageTelemetryEnabled(other)).toBe(true);
      const event = { message: "crash" };
      await expect(initOptions().beforeSend(event, undefined)).resolves.toBe(
        event,
      );
    });

    it("opted out, then a project that opts in -> usage stays off, no client and no metric", async () => {
      await initRootThenOther(
        { sendCrashReports: false, sendUsageTelemetry: false },
        { sendCrashReports: true, sendUsageTelemetry: true },
      );

      expect(isUsageTelemetryEnabled(other)).toBe(false);
      expect(Sentry.init).not.toHaveBeenCalled();
      expect(Sentry.metrics.count).not.toHaveBeenCalled();
    });

    it("neither prompts for nor persists the unset flags of the other project", async () => {
      setInteractive(true);
      const prompt = jest.fn().mockResolvedValue(true);

      await initRootThenOther(
        { sendCrashReports: false, sendUsageTelemetry: true },
        {},
        prompt,
      );

      expect(prompt).not.toHaveBeenCalled();
      expect(fs.readJsonSync(path.join(other, "cdktf.json"))).toEqual({});
    });
  });
});

describe("start-of-command metric (initializErrorReporting)", () => {
  useReportingFixture();

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

    expect(invokedCalls()).toHaveLength(1);
    expect(invokedCalls()[0][2]).toEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({
          command: "deploy",
          language: "python",
        }),
      }),
    );
    expect((Sentry.init as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (Sentry.metrics.count as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it("reads the language and the declared targets from the explicit project path", async () => {
    const destination = path.join(workdir, "new-project");
    fs.mkdirpSync(destination);
    fs.writeJsonSync(path.join(destination, "cdktf.json"), {
      language: "go",
      sendCrashReports: false,
      targetVersions: { terraform: ">=1.9.0" },
    });
    setInteractive(false);
    Errors.setScope("init");

    await initializErrorReporting(undefined, undefined, destination);

    expect(invokedCalls()[0][2]).toEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({
          command: "init",
          language: "go",
          target_terraform: ">=1.9.0",
        }),
      }),
    );
  });

  it("emits nothing on a crash-only init (usage telemetry declined)", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      sendCrashReports: true,
      sendUsageTelemetry: false,
    });
    setInteractive(false);

    await initializErrorReporting();

    expect(Sentry.init).toHaveBeenCalledTimes(1);
    expect(Sentry.metrics.count).not.toHaveBeenCalled();
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
    [{ sendCrashReports: "true" }, true],
    // undefined, not false, for an absent or malformed flag: that is what
    // triggers the crash-consent prompt
    [{}, undefined],
    [{ sendCrashReports: "yes" }, undefined],
  ])("reads %j as %p", (config, expected) => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), config);
    expect(shouldReportCrash(workdir)).toBe(expected);
  });

  it("returns false outside a project (missing cdktf.json)", () => {
    expect(shouldReportCrash(workdir)).toBe(false);
  });
});
