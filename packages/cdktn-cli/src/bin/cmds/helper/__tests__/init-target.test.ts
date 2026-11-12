// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { select } from "@inquirer/prompts";

jest.mock("@npmcli/ci-detect", () => () => false);
jest.mock("@inquirer/prompts", () => ({
  ...jest.requireActual("@inquirer/prompts"),
  select: jest.fn(),
}));
jest.mock("../check-environment", () => ({
  ...jest.requireActual("../check-environment"),
  checkEnvironment: jest.fn().mockResolvedValue(undefined),
  isInteractiveTerminal: () => true,
}));
jest.mock("../version-check", () => ({
  displayVersionMessage: jest.fn().mockResolvedValue(undefined),
}));
// Each records the binary it would run
const mockBinaries: Record<string, string | undefined> = {};
jest.mock("../terraform-check", () => ({
  terraformCheck: jest.fn(async () => {
    mockBinaries.versionCheck = process.env.TERRAFORM_BINARY_NAME;
  }),
  getTerraformVersion: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../init", () => ({
  ...jest.requireActual("../init"),
  checkForEmptyDirectory: jest.fn(),
}));
jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  sendTelemetry: jest.fn(),
}));

const mockInitLib = jest.fn();
jest.mock("@cdktn/cli-core", () => ({
  ...jest.requireActual("@cdktn/cli-core"),
  init: (...args: unknown[]) => mockInitLib(...args),
}));

import { init } from "../../handlers";
import { RunInitOptions } from "../init";

describe("init target", () => {
  let destination: string;
  const originalBinary = process.env.TERRAFORM_BINARY_NAME;

  const run = (options: Partial<RunInitOptions>) =>
    init({
      destination,
      local: true,
      silent: true,
      template: "typescript",
      projectName: "test",
      projectDescription: "test",
      fromTerraformProject: "no",
      enableCrashReporting: false,
      enableUsageTelemetry: false,
      providers: ["aws"],
      ...options,
    });

  beforeEach(() => {
    delete process.env.TERRAFORM_BINARY_NAME;
    for (const key of Object.keys(mockBinaries)) delete mockBinaries[key];
    destination = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-init-"));
    mockInitLib.mockImplementation(async () => {
      mockBinaries.init = process.env.TERRAFORM_BINARY_NAME;
      fs.writeJsonSync(path.join(destination, "cdktf.json"), {
        language: "typescript",
        app: "npx tsx main.ts",
      });
      return false;
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
    fs.removeSync(destination);
    if (originalBinary === undefined) {
      delete process.env.TERRAFORM_BINARY_NAME;
    } else {
      process.env.TERRAFORM_BINARY_NAME = originalBinary;
    }
  });

  it("runs tofu for all of init, the version check included, when targeting OpenTofu", async () => {
    await run({ target: "opentofu", nonInteractive: true });

    expect(mockInitLib).toHaveBeenCalledWith(
      expect.objectContaining({ target: "opentofu" }),
    );
    expect(mockBinaries).toEqual({ versionCheck: "tofu", init: "tofu" });
  });

  it("asks for the target when run interactively", async () => {
    (select as jest.Mock).mockResolvedValue("opentofu");

    await run({});

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Which CLI will run this project?" }),
    );
    expect(mockInitLib).toHaveBeenCalledWith(
      expect.objectContaining({ target: "opentofu" }),
    );
    expect(mockBinaries.versionCheck).toBe("tofu");
  });

  it("keeps the template's targets and binary without a target or a prompt", async () => {
    await run({ nonInteractive: true });

    expect(select).not.toHaveBeenCalled();
    expect(mockInitLib).toHaveBeenCalledWith(
      expect.objectContaining({ target: undefined }),
    );
    expect(mockBinaries).toEqual({ versionCheck: undefined, init: undefined });
  });
});
