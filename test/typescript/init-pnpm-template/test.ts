// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import {
  TestDriver,
  onPosix,
  packageJsonWithDependency,
} from "../../test-helper";

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

describe("typescript-pnpm init template with an unusable pnpm", () => {
  describe.each([
    [
      "too old",
      '#!/bin/sh\n[ "$1" = "--version" ] && echo 9.15.0\n',
      "pnpm 9.15.0 is too old",
    ],
    ["missing", undefined, 'Could not find "pnpm"'],
  ])("pnpm %s", (_, shim, message) => {
    onPosix(
      "fails without writing anything and keeps what was already there",
      async () => {
        const driver = new TestDriver(__dirname);
        driver.shadowBinary("pnpm", shim);
        driver.switchToTempDir();
        // Entries the empty-directory check allows a new project to start with.
        fs.mkdirSync(path.join(driver.workingDirectory, ".git"));
        fs.writeFileSync(
          path.join(driver.workingDirectory, ".git", "HEAD"),
          "",
        );
        fs.writeFileSync(path.join(driver.workingDirectory, "README.md"), "");

        await expect(driver.init("typescript-pnpm")).rejects.toMatchObject({
          stderr: expect.stringContaining(message),
        });
        expect(fs.readdirSync(driver.workingDirectory).sort()).toEqual([
          ".git",
          "README.md",
        ]);
        expect(
          fs.existsSync(path.join(driver.workingDirectory, ".git", "HEAD")),
        ).toBe(true);
      },
      120_000,
    );
  });

  onPosix(
    "keeps the scaffolded files when the install fails",
    async () => {
      const driver = new TestDriver(__dirname);
      driver.shadowBinary(
        "pnpm",
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 11.5.2; exit 0; fi\necho "pnpm shim refuses: $*" >&2\nexit 1\n',
      );
      driver.switchToTempDir();

      await expect(driver.init("typescript-pnpm")).rejects.toMatchObject({
        stderr: expect.stringContaining("pnpm shim refuses"),
      });
      expect(fs.readdirSync(driver.workingDirectory)).toEqual(
        expect.arrayContaining([
          "main.ts",
          "package.json",
          "pnpm-workspace.yaml",
        ]),
      );
    },
    120_000,
  );
});
