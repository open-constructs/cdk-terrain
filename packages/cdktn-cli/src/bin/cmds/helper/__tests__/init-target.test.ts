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
  isInteractiveTerminal: () => true,
}));
jest.mock("../terraform-check", () => ({
  getTerraformVersion: jest.fn().mockResolvedValue(undefined),
}));

const mockInitLib = jest.fn();
jest.mock("@cdktn/cli-core", () => ({
  ...jest.requireActual("@cdktn/cli-core"),
  init: (...args: unknown[]) => mockInitLib(...args),
}));

import { runInit, RunInitOptions } from "../init";

describe("runInit target", () => {
  let destination: string;
  let binaryDuringInit: string | undefined;
  const originalBinary = process.env.TERRAFORM_BINARY_NAME;

  const run = (options: Partial<RunInitOptions>) =>
    runInit({
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
    destination = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-init-"));
    mockInitLib.mockImplementation(async () => {
      binaryDuringInit = process.env.TERRAFORM_BINARY_NAME;
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

  it("runs tofu for the rest of init when targeting OpenTofu", async () => {
    await run({ target: "opentofu", nonInteractive: true });

    expect(mockInitLib).toHaveBeenCalledWith(
      expect.objectContaining({ target: "opentofu" }),
    );
    expect(binaryDuringInit).toBe("tofu");
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
  });

  it("keeps the template's targets and binary without a target or a prompt", async () => {
    await run({ nonInteractive: true });

    expect(select).not.toHaveBeenCalled();
    expect(mockInitLib).toHaveBeenCalledWith(
      expect.objectContaining({ target: undefined }),
    );
    expect(binaryDuringInit).toBeUndefined();
  });
});
