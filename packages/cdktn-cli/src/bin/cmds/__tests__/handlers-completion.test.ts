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
  flush: jest.fn().mockResolvedValue(true),
  getCurrentScope: jest.fn(() => ({
    setUser: jest.fn(),
    setTag: jest.fn(),
    setPropagationContext: jest.fn(),
    setTransactionName: jest.fn(),
  })),
  setContext: jest.fn(),
  addBreadcrumb: jest.fn(),
  metrics: { count: jest.fn(), distribution: jest.fn() },
}));
jest.mock("../helper/version-check", () => ({
  displayVersionMessage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../helper/terraform-check", () => ({
  terraformCheck: jest.fn().mockResolvedValue(undefined),
  getTerraformVersion: jest.fn().mockResolvedValue(undefined),
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
jest.mock("../helper/utilities", () => ({
  ...jest.requireActual("../helper/utilities"),
  readStreamAsString: jest.fn().mockResolvedValue("resource {}"),
}));
jest.mock("@cdktn/provider-schema", () => ({
  ...jest.requireActual("@cdktn/provider-schema"),
  readSchema: jest.fn().mockResolvedValue({ providerSchema: {} }),
}));
const mockConvertLib = jest.fn();
jest.mock("@cdktn/hcl2cdk", () => ({
  ...jest.requireActual("@cdktn/hcl2cdk"),
  convert: (...args: unknown[]) => mockConvertLib(...args),
}));
jest.mock("ci-info", () => ({ isCI: false, name: null }));

const mockProviderAddLib = jest.fn();
const mockInitLib = jest.fn();
const mockGetLib = jest.fn();
const mockDependencyManager = {
  allProviders: jest.fn(),
  upgradeProvider: jest.fn(),
};
jest.mock("@cdktn/cli-core", () => ({
  ...jest.requireActual("@cdktn/cli-core"),
  providerAdd: (...args: unknown[]) => mockProviderAddLib(...args),
  init: (...args: unknown[]) => mockInitLib(...args),
  get: (...args: unknown[]) => mockGetLib(...args),
  DependencyManager: jest.fn(() => mockDependencyManager),
}));
jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  getPackageVersion: jest.fn().mockResolvedValue("0.23.0"),
  // crash reporting runs it in the background; the real one spawns npm and
  // terraform in a workdir afterEach removes
  collectDebugInformation: jest.fn().mockResolvedValue({}),
}));

import {
  convert,
  get,
  init as initHandler,
  list,
  output,
  providerAdd,
  providerList,
  providerUpgrade,
  watch,
} from "../handlers";
import { verifySimilarLibraryVersion } from "../helper/check-environment";
import { runWatch } from "../ui/watch";
import { terraformCheck } from "../helper/terraform-check";

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
  const init = Sentry.init as jest.Mock;

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
    init.mockClear();
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

  it("watch does not count completed when a deploy fails", async () => {
    (runWatch as jest.Mock).mockRejectedValueOnce(
      new Error("terraform apply failed"),
    );
    Errors.setScope("watch");

    await expect(watch({ autoApprove: true })).rejects.toThrow(
      "terraform apply failed",
    );

    expect(metricCalls("cli.command.invoked")).toHaveLength(1);
    expect(metricCalls("cli.command.completed")).toHaveLength(0);
  });

  // needsGet runs a nested get; its own completion must not count
  it.each([false, true])(
    "provider add (needsGet %p) counts invoked and completed once each",
    async (needsGet) => {
      mockProviderAddLib.mockResolvedValue(needsGet);
      const log = jest.spyOn(console, "log").mockImplementation(() => {});
      Errors.setScope("provider add");

      try {
        await providerAdd({ provider: ["aws"], silent: true });
      } finally {
        log.mockRestore();
      }

      for (const metric of ["cli.command.invoked", "cli.command.completed"]) {
        expect(metricCalls(metric)).toEqual([
          [
            metric,
            1,
            {
              attributes: expect.objectContaining({
                command: "provider add",
              }),
            },
          ],
        ]);
      }
    },
  );

  describe("provider list and provider upgrade", () => {
    let log: jest.SpyInstance;

    const expectInvokedAndCompletedOnce = (command: string) => {
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
    };

    beforeEach(() => {
      log = jest.spyOn(console, "log").mockImplementation(() => {});
      mockDependencyManager.allProviders.mockResolvedValue({
        local: [{ providerName: "aws", providerConstraint: "~> 5.0" }],
        prebuilt: [],
      });
      mockDependencyManager.upgradeProvider.mockResolvedValue({
        addedLocalProvider: true,
      });
      mockGetLib.mockResolvedValue(undefined);
    });

    afterEach(() => {
      log.mockRestore();
    });

    it.each([true, false])(
      "provider list (json %p) counts invoked and completed once each",
      async (json) => {
        Errors.setScope("provider list");

        await providerList({ json });

        expect(log).toHaveBeenCalledWith(expect.stringContaining("aws"));
        expectInvokedAndCompletedOnce("provider list");
      },
    );

    it("provider list does not count completed when it fails before printing", async () => {
      (terraformCheck as jest.Mock).mockRejectedValueOnce(
        Errors.Usage("unsupported terraform"),
      );
      Errors.setScope("provider list");

      await expect(providerList({ json: false })).rejects.toThrow(
        "unsupported terraform",
      );

      expect(metricCalls("cli.command.invoked")).toHaveLength(1);
      expect(metricCalls("cli.command.completed")).toHaveLength(0);
    });

    it("provider upgrade counts invoked and completed once each", async () => {
      Errors.setScope("provider upgrade");

      await providerUpgrade({ provider: ["aws@~>5.0"] });

      expect(mockGetLib).toHaveBeenCalledTimes(1);
      expectInvokedAndCompletedOnce("provider upgrade");
    });

    it("provider upgrade does not count completed when generating the bindings fails", async () => {
      mockGetLib.mockRejectedValueOnce(new Error("generation failed"));
      Errors.setScope("provider upgrade");

      await expect(
        providerUpgrade({ provider: ["aws@~>5.0"] }),
      ).rejects.toThrow("generation failed");

      expect(metricCalls("cli.command.invoked")).toHaveLength(1);
      expect(metricCalls("cli.command.completed")).toHaveLength(0);
    });
  });

  describe("init", () => {
    const runInit = () =>
      initHandler({
        local: true,
        silent: true,
        nonInteractive: true,
        template: "typescript",
        projectName: "test",
        projectDescription: "test",
        fromTerraformProject: "no",
        enableCrashReporting: false,
        enableUsageTelemetry: true,
      });

    beforeEach(() => {
      // init refuses a non-empty directory; the scaffold writes the project
      fs.removeSync(path.join(workdir, "cdktf.json"));
      mockInitLib.mockImplementation(async () => {
        fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
          language: "typescript",
          app: "npx ts-node main.ts",
          sendCrashReports: false,
        });
        return true;
      });
      Errors.setScope("init");
    });

    it("counts completed once, after the nested get", async () => {
      await runInit();

      for (const metric of ["cli.command.invoked", "cli.command.completed"]) {
        expect(metricCalls(metric)).toEqual([
          [
            metric,
            1,
            {
              attributes: expect.objectContaining({
                command: "init",
                language: "typescript",
              }),
            },
          ],
        ]);
      }
    });

    it("does not count completed when the nested get fails", async () => {
      (verifySimilarLibraryVersion as jest.Mock).mockRejectedValueOnce(
        Errors.External("library version mismatch"),
      );

      await expect(runInit()).rejects.toThrow("library version mismatch");

      expect(metricCalls("cli.command.invoked")).toHaveLength(1);
      expect(metricCalls("cli.command.completed")).toHaveLength(0);
    });
  });

  // A target other than typescript converts inside a temporary project that
  // opts out of both flags; with a provider, init runs a nested get there.
  describe("convert through a temporary project", () => {
    let temporaryProject: string | undefined;

    beforeEach(() => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
        app: "npx ts-node main.ts",
        sendCrashReports: true,
        sendUsageTelemetry: true,
      });
      temporaryProject = undefined;
      // the scaffold persists the flags and providers init was given
      mockInitLib.mockImplementation(
        async ({
          destination,
          sendCrashReports,
          sendUsageTelemetry,
          providers,
        }) => {
          temporaryProject = path.resolve(destination);
          fs.writeJsonSync(path.join(temporaryProject, "cdktf.json"), {
            language: "typescript",
            app: "npx ts-node main.ts",
            sendCrashReports,
            sendUsageTelemetry,
            terraformProviders: providers,
          });
          return true;
        },
      );
      mockGetLib.mockReset().mockResolvedValue(undefined);
      mockConvertLib.mockResolvedValue({ all: "", stats: {} });
      Errors.setScope("convert");
    });

    afterEach(() => {
      if (temporaryProject) {
        fs.removeSync(temporaryProject);
      }
    });

    const convertToPython = async () => {
      const log = jest.spyOn(console, "log").mockImplementation(() => {});
      try {
        await convert({ language: "python", provider: ["aws@~>5.0"] });
      } finally {
        log.mockRestore();
      }
      // the bindings were generated in the temporary project, not the user's
      expect(mockGetLib).toHaveBeenCalledTimes(1);
      expect(temporaryProject).not.toBe(workdir);
    };

    it("counts invoked and completed once each under the consent of the user's project", async () => {
      await convertToPython();

      for (const metric of ["cli.command.invoked", "cli.command.completed"]) {
        expect(metricCalls(metric)).toEqual([
          [
            metric,
            1,
            { attributes: expect.objectContaining({ command: "convert" }) },
          ],
        ]);
      }
    });

    it("keeps reporting crashes under the consent of the user's project", async () => {
      await convertToPython();

      const event = { message: "crash" };
      await expect(
        init.mock.calls.at(-1)![0].beforeSend(event, undefined),
      ).resolves.toBe(event);
    });
  });
});
