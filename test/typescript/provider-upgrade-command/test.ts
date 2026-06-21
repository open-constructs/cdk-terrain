// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  TestDriver,
  onPosix,
  onWindows,
  packageJsonWithDependency,
} from "../../test-helper";

describe("provider upgrade command", () => {
  let driver: TestDriver;
  beforeEach(async () => {
    driver = new TestDriver(__dirname, {
      CDKTN_OVERRIDE_VERSION: "0.23.1",
      CI: "1",
    }); // fake cdktn version for consistent provider version checks
    await driver.setupTypescriptProject();
  }, 500_000);

  describe("pre-built", () => {
    it("can update within the same cdktn version to a specific version", async () => {
      await driver.exec("cdktn", ["provider", "add", "random@=3.7.2"]);

      expect(driver.packageJson()).toEqual(
        packageJsonWithDependency("@cdktn/provider-random", "12.1.0"),
      );

      await driver.exec("cdktn", ["provider", "upgrade", "random@=3.8.1"]);

      expect(driver.packageJson()).toEqual(
        packageJsonWithDependency("@cdktn/provider-random", "12.1.1"),
      );
    });

    it("can update within the same cdktn version to the latest version", async () => {
      await driver.exec("cdktn", ["provider", "add", "random@=3.7.2"]);

      expect(driver.packageJson()).toEqual(
        packageJsonWithDependency("@cdktn/provider-random", "12.1.0"),
      );

      await driver.exec("cdktn", ["provider", "upgrade", "random"]);

      expect(driver.packageJson()).toEqual(
        packageJsonWithDependency("@cdktn/provider-random", "12.1.1"),
      );
    });

    it("can update within the same cdktn version to the latest version in npm", async () => {
      // Pin random provider version so that the upgrade can do anything
      await driver.exec("npm", [
        "install",
        "--save-exact",
        "@cdktn/provider-acme@13.0.0",
      ]);
      expect(driver.packageJson()).toEqual(
        packageJsonWithDependency("@cdktn/provider-acme", "13.0.0"),
      );
      await driver.exec("rm", ["-rf", "node_modules"]);
      await driver.exec("rm", ["package-lock.json"]);
      await driver.exec("npm", ["install"]); // npm install to update the lockfile
      await driver.exec("cdktn", ["provider", "upgrade", "acme"]);

      expect(driver.packageJson()).toEqual(
        packageJsonWithDependency("@cdktn/provider-acme", "13.3.1"),
      );
    });
  });

  describe("local", () => {
    beforeEach(async () => {
      await driver.exec("cdktn", [
        "provider",
        "add",
        "random@=3.1.3", // this is not the latest version, but theres v0.2.55 of the pre-built provider resulting in exactly this package
        "--force-local",
      ]);
    });

    onPosix("can update to a specific version", async () => {
      await driver.exec("cdktn", ["provider", "upgrade", "random@=3.2.0"]);

      // Assert that we have version 3.2.0 in the cdktf.json and get ran
      const genVersionsFile = JSON.parse(
        driver.readLocalFile(".gen/versions.json"),
      );

      expect(genVersionsFile["registry.terraform.io/hashicorp/random"]).toEqual(
        "3.2.0",
      );
    });

    onWindows(
      "upgrade local provider on windows",
      async () => {
        await driver.exec("cdktn", ["provider", "upgrade", "random@=3.2.0"]);
        const config = JSON.parse(driver.readLocalFile("cdktf.json"));
        expect(config.terraformProviders).toMatchInlineSnapshot(`
        [
          "hashicorp/random@=3.2.0",
        ]
      `);

        // Assert that we have version 3.2.0 in the cdktf.json and get ran
        const genVersionsFile = JSON.parse(
          driver.readLocalFile(".gen/versions.json"),
        );

        expect(
          genVersionsFile["registry.terraform.io/hashicorp/random"],
        ).toEqual("3.2.0");
      },
      120_000,
    );
  });
});
