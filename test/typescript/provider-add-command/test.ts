// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  TestDriver,
  onPosix,
  onWindows,
  packageJsonWithDependency,
} from "../../test-helper";

describe("provider add command", () => {
  describe("pre-built", () => {
    let driver: TestDriver;
    beforeEach(async () => {
      driver = new TestDriver(__dirname, {
        CDKTN_OVERRIDE_VERSION: "0.23.1",
      }); // fake cdktn version for consistent provider version checks
      await driver.setupTypescriptProject();
    }, 500_000);

    it("detects correct cdktn version", async () => {
      const res = await driver.exec("cdktn", ["debug"]);
      expect(res.stdout).toContain("cdktn: 0.23.1");
    });

    test("installs pre-built provider using npm", async () => {
      const res = await driver.exec("cdktn", [
        "provider",
        "add",
        "random@=3.9.0",
      ]);
      expect(res.stdout).toContain(
        `Checking whether pre-built provider exists for the following constraints:`,
      );
      expect(res.stdout).toContain(`provider: random`);
      expect(res.stdout).toContain(`version : =3.9.0`);
      expect(res.stdout).toContain(`language: typescript`);
      expect(res.stdout).toContain(`cdktn   : 0.23.1`);
      expect(res.stdout).toContain(`Found pre-built provider.`);
      expect(res.stdout).toContain(
        `Adding package @cdktn/provider-random @ 14.1.0`,
      );
      expect(res.stdout).toContain(
        `Installing package @cdktn/provider-random @ 14.1.0 using npm.`,
      );
      expect(res.stdout).toContain(`Package installed.`);

      expect(driver.packageJson()).toEqual(
        packageJsonWithDependency("@cdktn/provider-random"),
      );
    }, 120_000);
  });

  describe("local", () => {
    let driver: TestDriver;
    beforeEach(async () => {
      driver = new TestDriver(__dirname);
      await driver.setupTypescriptProject();
    }, 500_000);

    onPosix(
      "adds local provider on posix",
      async () => {
        const res = await driver.exec("cdktn", [
          "provider",
          "add",
          "local@=2.2.3",
          "--force-local",
        ]);
        const config = JSON.parse(driver.readLocalFile("cdktf.json"));
        expect(config.terraformProviders).toMatchInlineSnapshot(`
          [
            "hashicorp/local@=2.2.3",
          ]
        `);

        expect(res.stdout).toContain(
          `Local providers have been updated. Running cdktn get to update...`,
        );

        const genVersionsFile = JSON.parse(
          driver.readLocalFile(".gen/versions.json"),
        );

        expect(
          genVersionsFile["registry.terraform.io/hashicorp/local"],
        ).toEqual("2.2.3");
      },
      240_000,
    );

    onWindows(
      "adds local provider on windows",
      async () => {
        const res = await driver.exec("cdktn", [
          "provider",
          "add",
          "local@=2.2.3",
          "--force-local",
        ]);
        const config = JSON.parse(driver.readLocalFile("cdktf.json"));
        expect(config.terraformProviders).toMatchInlineSnapshot(`
                  [
                    "hashicorp/local@=2.2.3",
                  ]
              `);

        expect(res.stdout).toContain(
          `Local providers have been updated. Running cdktn get to update...`,
        );

        const genVersionsFile = JSON.parse(
          driver.readLocalFile(".gen/versions.json"),
        );

        expect(
          genVersionsFile["registry.terraform.io/hashicorp/local"],
        ).toEqual("2.2.3");
      },
      120_000,
    );
  });
});
