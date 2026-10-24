// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  OPENTOFU_REGISTRY,
  TERRAFORM_REGISTRY,
  TerraformTargetVersions,
} from "@cdktn/commons";
import { CdktfConfigManager } from "../../../lib/dependencies/cdktf-config-manager";
import { ProviderConstraint } from "../../../lib/dependencies/dependency-manager";

describe("CdktfConfigManager", () => {
  let projectDir: string;
  let originalCwd: string;

  const writeConfig = (
    providers: string[],
    targetVersions?: TerraformTargetVersions,
  ) =>
    fs.writeFileSync(
      path.join(projectDir, "cdktf.json"),
      JSON.stringify({
        language: "typescript",
        app: "npx tsx main.ts",
        terraformProviders: providers,
        ...(targetVersions ? { targetVersions } : {}),
      }),
    );

  const readProviders = (): string[] =>
    JSON.parse(fs.readFileSync(path.join(projectDir, "cdktf.json"), "utf8"))
      .terraformProviders;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktf-config-mgr-"));
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  describe("a Terraform project", () => {
    it("writes the short form and replaces the existing entry", async () => {
      writeConfig(["hashicorp/random@=3.1.3"]);

      await new CdktfConfigManager().updateProvider(
        new ProviderConstraint("random", "=3.2.0", TERRAFORM_REGISTRY),
      );

      expect(readProviders()).toEqual(["hashicorp/random@=3.2.0"]);
    });
  });

  describe("an OpenTofu project", () => {
    const opentofu: TerraformTargetVersions = { opentofu: ">=1.6.0" };

    it("writes the short form rather than qualifying with the tofu registry", async () => {
      writeConfig(["hashicorp/random@=3.1.3"], opentofu);

      await new CdktfConfigManager().updateProvider(
        new ProviderConstraint("random", "=3.2.0", OPENTOFU_REGISTRY),
      );

      expect(readProviders()).toEqual(["hashicorp/random@=3.2.0"]);
    });

    it("recognises an unqualified entry as the same provider", async () => {
      writeConfig(["hashicorp/random@=3.1.3"], opentofu);

      await expect(
        new CdktfConfigManager().hasProvider(
          new ProviderConstraint("random", "=3.1.3", OPENTOFU_REGISTRY),
        ),
      ).resolves.toBe(true);
    });

    it("keeps a source explicitly qualified with another registry", async () => {
      writeConfig([], opentofu);

      await new CdktfConfigManager().addProvider(
        new ProviderConstraint(
          "registry.terraform.io/hashicorp/random",
          "=3.2.0",
          OPENTOFU_REGISTRY,
        ),
      );

      expect(readProviders()).toEqual([
        "registry.terraform.io/hashicorp/random@=3.2.0",
      ]);
    });

    it("treats an explicitly qualified entry as distinct from the project's own", async () => {
      writeConfig(["registry.terraform.io/hashicorp/random@=3.1.3"], opentofu);

      await new CdktfConfigManager().addProvider(
        new ProviderConstraint("random", "=3.2.0", OPENTOFU_REGISTRY),
      );

      expect(readProviders()).toEqual([
        "registry.terraform.io/hashicorp/random@=3.1.3",
        "hashicorp/random@=3.2.0",
      ]);
    });
  });
});
