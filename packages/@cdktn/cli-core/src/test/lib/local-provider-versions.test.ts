// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LocalProviderVersions } from "../../lib/local-provider-versions";

describe("LocalProviderVersions", () => {
  let projectDir: string;
  let originalCwd: string;

  const writeProject = (versions: Record<string, string>) => {
    fs.writeFileSync(
      path.join(projectDir, "cdktf.json"),
      JSON.stringify({ language: "typescript", app: "npx tsx main.ts" }),
    );
    fs.mkdirSync(path.join(projectDir, ".gen"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".gen", "versions.json"),
      JSON.stringify(versions),
    );
  };

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-versions-"));
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("reads a provider fetched by Terraform", async () => {
    writeProject({ "registry.terraform.io/hashicorp/random": "3.2.0" });

    await expect(
      new LocalProviderVersions().versionForProvider("random"),
    ).resolves.toBe("3.2.0");
  });

  it("reads a provider fetched by OpenTofu", async () => {
    writeProject({ "registry.opentofu.org/hashicorp/random": "3.2.0" });

    await expect(
      new LocalProviderVersions().versionForProvider("random"),
    ).resolves.toBe("3.2.0");
  });

  it("keeps a private registry host in the key", async () => {
    writeProject({ "my.registry.example.com/hashicorp/random": "3.2.0" });

    const versions = new LocalProviderVersions();
    await expect(
      versions.versionForProvider("random"),
    ).resolves.toBeUndefined();
    // The default namespace is still dropped wherever it appears, which is
    // pre-existing behaviour this change does not alter.
    await expect(
      versions.versionForProvider("my.registry.example.com/random"),
    ).resolves.toBe("3.2.0");
  });

  it("keeps a non-default namespace", async () => {
    writeProject({ "registry.opentofu.org/kreuzwerker/docker": "3.9.0" });

    await expect(
      new LocalProviderVersions().versionForProvider("kreuzwerker/docker"),
    ).resolves.toBe("3.9.0");
  });
});
