// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

const mockVersion = jest.fn();
jest.mock("@cdktn/cli-core", () => ({
  ...jest.requireActual("@cdktn/cli-core"),
  TerraformCli: jest.fn().mockImplementation(() => ({
    version: () => mockVersion(),
  })),
}));

import { terraformCheck } from "../terraform-check";

describe("terraformCheck", () => {
  let workdir: string;
  const originalCwd = process.cwd();
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-tf-check-"));
    process.chdir(workdir);
    mockVersion.mockResolvedValue("Terraform v1.5.0");
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.chdir(originalCwd);
    fs.removeSync(workdir);
  });

  it("resolves on a supported version and warns on an old one", async () => {
    await expect(terraformCheck()).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();

    mockVersion.mockResolvedValue("Terraform v1.1.0");
    await expect(terraformCheck()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unsupported Terraform version [1.1.0]"),
    );
  });

  it("throws a Usage error for a legacy terraform.tfstate instead of exiting", async () => {
    fs.writeFileSync(path.join(workdir, "terraform.tfstate"), "{}");
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    try {
      await expect(terraformCheck()).rejects.toMatchObject({ __type: "Usage" });
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
