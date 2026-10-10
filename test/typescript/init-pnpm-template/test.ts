// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import { TestDriver, packageJsonWithDependency } from "../../test-helper";

describe("typescript-pnpm init template", () => {
  let driver: TestDriver;
  beforeAll(async () => {
    // Pre-built providers only resolve against a published cdktn, which then
    // no longer matches the locally built CLI.
    driver = new TestDriver(__dirname, { DISABLE_VERSION_CHECK: "true" });
    driver.switchToTempDir();
    await driver.init("typescript-pnpm");
  }, 500_000);

  const projectFiles = () => fs.readdirSync(driver.workingDirectory);

  it("scaffolds a project managed by pnpm", () => {
    expect(projectFiles()).toContain("pnpm-lock.yaml");
    expect(projectFiles()).not.toContain("package-lock.json");

    const packageJson = driver.packageJson();
    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+/);
    expect(packageJson.scripts.upgrade).toContain("pnpm add");
    expect(JSON.parse(driver.readLocalFile("cdktf.json")).app).toMatch(
      /^pnpm /,
    );
  });

  it("synthesizes the scaffolded app", async () => {
    await driver.synth();

    const stackName = path.basename(driver.workingDirectory);
    expect(Object.keys(JSON.parse(driver.manifest()).stacks)).toEqual([
      stackName,
    ]);
  }, 120_000);

  describe("with a pre-built provider", () => {
    let addOutput: string;
    beforeAll(async () => {
      await driver.exec("pnpm", ["add", "cdktn@0.23.1"]);
      addOutput = (
        await driver.exec("cdktn", ["provider", "add", "random@=3.9.0"])
      ).stdout;
    }, 300_000);

    it("installs the provider with pnpm", () => {
      expect(addOutput).toContain(
        "Installing package @cdktn/provider-random @ 14.1.0 using pnpm.",
      );
      expect(driver.packageJson()).toEqual(
        packageJsonWithDependency("@cdktn/provider-random", "14.1.0"),
      );
      expect(projectFiles()).not.toContain("package-lock.json");
    });

    it("lists the provider installed by pnpm", async () => {
      const res = await driver.exec("cdktn", ["provider", "list", "--json"]);

      expect(JSON.parse(res.stdout).prebuilt).toEqual([
        expect.objectContaining({
          packageName: "@cdktn/provider-random",
          packageVersion: "14.1.0",
          providerName: "random",
          providerVersion: "3.9.0",
        }),
      ]);
    }, 120_000);
  });
});
