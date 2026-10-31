// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { setUsageTelemetryEnabled } from "@cdktn/commons";

jest.mock("../helper/version-check", () => ({
  displayVersionMessage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../helper/terraform-check", () => ({
  terraformCheck: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../helper/check-environment", () => ({
  ...jest.requireActual("../helper/check-environment"),
  checkEnvironment: jest.fn().mockResolvedValue(undefined),
}));

const mockRunWatch = jest.fn();
jest.mock("../ui/watch", () => ({
  runWatch: (...args: unknown[]) => mockRunWatch(...args),
}));
const mockRunSynth = jest.fn();
jest.mock("../ui/synth", () => ({
  runSynth: (...args: unknown[]) => mockRunSynth(...args),
}));

const mockRunInit = jest.fn();
jest.mock("../helper/init", () => ({
  ...jest.requireActual("../helper/init"),
  checkForEmptyDirectory: jest.fn(),
  runInit: (...args: unknown[]) => mockRunInit(...args),
}));

jest.mock("ci-info", () => ({ isCI: false, name: null }));

import { init, synth, watch } from "../handlers";

describe("usage guards that run after reporting is initialized", () => {
  let workdir: string;
  const originalCwd = process.cwd();
  const originalSentryDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-watch-"));
    process.chdir(workdir);
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      language: "typescript",
      app: "npx ts-node main.ts",
      sendCrashReports: false,
    });
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    setUsageTelemetryEnabled(undefined);
    process.chdir(originalCwd);
    fs.removeSync(workdir);
    if (originalSentryDsn !== undefined) {
      process.env.SENTRY_DSN = originalSentryDsn;
    }
  });

  it("watch rejects with a Usage error and starts no watch without --auto-approve", async () => {
    await expect(watch({ autoApprove: false })).rejects.toMatchObject({
      __type: "Usage",
      message: expect.stringContaining("--auto-approve flag must be set"),
    });

    expect(mockRunWatch).not.toHaveBeenCalled();
  });

  it("synth --check-code-maker-output rejects with a Usage error and runs no synth without generated bindings", async () => {
    await expect(synth({ checkCodeMakerOutput: true })).rejects.toMatchObject({
      __type: "Usage",
      message: expect.stringContaining('run "cdktn get"'),
    });

    expect(mockRunSynth).not.toHaveBeenCalled();
  });
});

describe("init --from-terraform-project guard", () => {
  beforeEach(() => mockRunInit.mockReset());

  // yargs parses a bare `--from-terraform-project` to "".
  it.each([
    ["an empty value", () => ""],
    ['"."', () => "."],
    ["the current directory", () => process.cwd()],
  ])("rejects %s with a Usage error", async (_label, value) => {
    await expect(init({ fromTerraformProject: value() })).rejects.toMatchObject(
      {
        __type: "Usage",
        message: expect.stringContaining(
          "--from-terraform-project requires a path",
        ),
      },
    );
    expect(mockRunInit).not.toHaveBeenCalled();
  });

  it.each([
    ["another path", "../my-tf-codebase"],
    ["no value", undefined],
  ])("passes %s through to runInit", async (_label, value) => {
    const reachedRunInit = new Error("reached runInit");
    mockRunInit.mockRejectedValue(reachedRunInit);

    await expect(init({ fromTerraformProject: value })).rejects.toBe(
      reachedRunInit,
    );
  });
});
