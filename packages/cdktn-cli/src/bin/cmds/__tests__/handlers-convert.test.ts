// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

// Only the seams around the conversion are stubbed: consent runs through the
// real initializErrorReporting against the cdktf.json of the test project.
const mockCrashPrompt = jest.fn();
const mockUsagePrompt = jest.fn();
jest.mock("../helper/error-reporting", () => ({
  askForCrashReportingConsent: () => mockCrashPrompt(),
  askForUsageTelemetryConsent: () => mockUsagePrompt(),
}));

const mockRunInit = jest.fn();
jest.mock("../helper/init", () => ({
  ...jest.requireActual("../helper/init"),
  runInit: (...args: unknown[]) => mockRunInit(...args),
}));

const mockConvert = jest.fn();
jest.mock("@cdktn/hcl2cdk", () => ({
  ...jest.requireActual("@cdktn/hcl2cdk"),
  convert: (...args: unknown[]) => mockConvert(...args),
}));

jest.mock("@cdktn/provider-schema", () => ({
  readSchema: jest.fn().mockResolvedValue({ providerSchema: {} }),
}));

jest.mock("../helper/utilities", () => ({
  ...jest.requireActual("../helper/utilities"),
  readStreamAsString: jest.fn().mockResolvedValue("resource {}"),
}));

jest.mock("../helper/terraform-check", () => ({
  terraformCheck: jest.fn().mockResolvedValue(undefined),
  getTerraformVersion: jest.fn().mockResolvedValue(null),
}));

jest.mock("../helper/version-check", () => ({
  displayVersionMessage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../helper/check-environment", () => ({
  ...jest.requireActual("../helper/check-environment"),
  checkEnvironment: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("ci-info", () => ({ isCI: false, name: null }));

import { setUsageTelemetryEnabled } from "@cdktn/commons";
import { convert } from "../handlers";

describe("convert consent", () => {
  let workdir: string;
  const originalCwd = process.cwd();
  const originalIsTTY = process.stdout.isTTY;
  const originalEnv = {
    CI: process.env.CI,
    SENTRY_DSN: process.env.SENTRY_DSN,
    CHECKPOINT_DISABLE: process.env.CHECKPOINT_DISABLE,
  };
  let logSpy: jest.SpyInstance;

  const setInteractive = (interactive: boolean) => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: interactive,
      configurable: true,
    });
  };

  const cdktfJson = () => fs.readJsonSync(path.join(workdir, "cdktf.json"));

  beforeEach(() => {
    jest.clearAllMocks();
    workdir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-convert-")),
    );
    process.chdir(workdir);
    delete process.env.CI;
    delete process.env.SENTRY_DSN;
    delete process.env.CHECKPOINT_DISABLE;
    setUsageTelemetryEnabled(undefined);
    mockCrashPrompt.mockResolvedValue(false);
    mockUsagePrompt.mockResolvedValue(true);
    mockRunInit.mockResolvedValue({
      needsGet: false,
      codeMakerOutput: ".gen",
      language: "typescript",
    });
    mockConvert.mockResolvedValue({ all: "", stats: {} });
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    setUsageTelemetryEnabled(undefined);
    setInteractive(originalIsTTY);
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

  it("prompts for both flags in the user's project before the temporary project work", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      language: "typescript",
      app: "npx ts-node main.ts",
    });
    setInteractive(true);
    const cwdAtPrompt: string[] = [];
    mockUsagePrompt.mockImplementation(async () => {
      cwdAtPrompt.push(process.cwd());
      return true;
    });

    // a non-typescript target drives init inside a throwaway project
    await convert({ language: "python", provider: [] });

    expect(mockCrashPrompt).toHaveBeenCalledTimes(1);
    expect(mockUsagePrompt).toHaveBeenCalledTimes(1);
    expect(cwdAtPrompt).toEqual([workdir]);
    expect(cdktfJson()).toMatchObject({
      sendCrashReports: false,
      sendUsageTelemetry: true,
    });
    expect(mockUsagePrompt.mock.invocationCallOrder[0]).toBeLessThan(
      mockRunInit.mock.invocationCallOrder[0],
    );
    // the decision captured in the user's cwd survives the throwaway
    // project, which opts out
    expect(mockRunInit.mock.calls[0][0]).toMatchObject({
      enableUsageTelemetry: false,
    });
    expect(process.cwd()).toBe(workdir);
  });

  it("does not prompt again when the flags are already set", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      language: "typescript",
      app: "npx ts-node main.ts",
      sendCrashReports: false,
      sendUsageTelemetry: false,
    });
    setInteractive(true);

    await convert({ language: "typescript", provider: [] });

    expect(mockCrashPrompt).not.toHaveBeenCalled();
    expect(mockUsagePrompt).not.toHaveBeenCalled();
    expect(cdktfJson()).toMatchObject({
      sendCrashReports: false,
      sendUsageTelemetry: false,
    });
  });

  it("stays prompt-free without a terminal and persists nothing", async () => {
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      language: "typescript",
      app: "npx ts-node main.ts",
    });
    setInteractive(false);

    await convert({ language: "typescript", provider: [] });

    expect(mockCrashPrompt).not.toHaveBeenCalled();
    expect(mockUsagePrompt).not.toHaveBeenCalled();
    expect(cdktfJson()).not.toHaveProperty("sendUsageTelemetry");
    expect(cdktfJson()).not.toHaveProperty("sendCrashReports");
  });
});
