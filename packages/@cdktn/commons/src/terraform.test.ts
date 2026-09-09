// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

// The probe spawns the configured binary at import, so every case loads a
// fresh module with TERRAFORM_BINARY_NAME pointing at a fixture script.
function loadProbe(binary: string) {
  const original = process.env.TERRAFORM_BINARY_NAME;
  process.env.TERRAFORM_BINARY_NAME = binary;
  try {
    let terraform: typeof import("./terraform");
    jest.isolateModules(() => {
      terraform = jest.requireActual("./terraform");
    });
    return terraform!;
  } finally {
    if (original === undefined) delete process.env.TERRAFORM_BINARY_NAME;
    else process.env.TERRAFORM_BINARY_NAME = original;
  }
}

describe("terraform binary probe", () => {
  let fixtureDir: string;

  function fakeBinary(name: string, output: string): string {
    const file = path.join(fixtureDir, name);
    fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${output}"\n`, {
      mode: 0o755,
    });
    return file;
  }

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-tf-probe-"));
  });

  afterEach(() => {
    fs.removeSync(fixtureDir);
  });

  it("recognizes Terraform from the first line of `version`", async () => {
    const { terraformCli, terraformVersion } = loadProbe(
      fakeBinary(
        "terraform",
        "Terraform v1.12.6\non darwin_arm64\n\nYour version of Terraform is out of date!",
      ),
    );
    await expect(terraformCli).resolves.toEqual({
      name: "terraform",
      version: "1.12.6",
    });
    await expect(terraformVersion).resolves.toBe("1.12.6");
  });

  it("recognizes OpenTofu from the first line of `version`", async () => {
    const { terraformCli, terraformVersion } = loadProbe(
      fakeBinary("tofu", "OpenTofu v1.8.1\non linux_amd64"),
    );
    await expect(terraformCli).resolves.toEqual({
      name: "opentofu",
      version: "1.8.1",
    });
    await expect(terraformVersion).resolves.toBe("1.8.1");
  });

  it("reports an unrecognized product as unknown", async () => {
    const { terraformCli } = loadProbe(
      fakeBinary("other", "SomethingElse v2.0.0"),
    );
    await expect(terraformCli).resolves.toEqual({
      name: "unknown",
      version: "2.0.0",
    });
  });

  it("resolves to missing (never rejects) when the binary cannot be spawned", async () => {
    const { terraformCli, terraformVersion } = loadProbe(
      path.join(fixtureDir, "does-not-exist"),
    );
    await expect(terraformCli).resolves.toEqual({ name: "missing" });
    // `cdktn debug` prints this value as-is
    const version = await terraformVersion;
    expect(version).toBeInstanceOf(Error);
    expect(String(version)).toMatch(
      /Usage Error: Unknown: Error loading terraform version/,
    );
  });
});
