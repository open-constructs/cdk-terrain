// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TestDriver } from "../../test-helper";

/** PyPI version pin for the cdktn library installed into the test project. */
const CDKTN_PIN = "cdktn~=0.22.1";

/**
 * Starting state: cdktn-provider-local 12.0.0 wraps Terraform local 2.7.0
 * and peer-depends on cdktn ^0.22.0.
 */
const INITIAL_PKG = "cdktn-provider-local==12.0.0";

/**
 * Upgrade target passed to `cdktn provider upgrade`. Selecting Terraform local
 * 2.8.0 forces the resolver to pick a different package than the initial one.
 */
const UPGRADE_TARGET = "local@=2.8.0";

/**
 * Expected Pipfile entry after the upgrade: cdktn-provider-local 12.1.0 is
 * the highest package in the 12.x line whose Terraform local version is 2.8.0.
 */
const UPGRADED_PIPFILE_LINE = `cdktn-provider-local = "~=12.1.0"`;

/** Same expectation as {@link UPGRADED_PIPFILE_LINE} but in requirements.txt syntax. */
const UPGRADED_REQUIREMENTS_LINE = `cdktn-provider-local~=12.1.0`;

describe("provider upgrade command", () => {
  let driver: TestDriver;

  describe("pre-built", () => {
    describe("pipenv", () => {
      beforeAll(async () => {
        driver = new TestDriver(__dirname, {
          // disable version check: locally-installed cdktn-cli is 0.0.0 (from dist),
          // project pins a published cdktn version
          DISABLE_VERSION_CHECK: "true",
        });
        await driver.setupPythonProject();

        await driver.exec("pipenv", ["install", CDKTN_PIN]);
      });

      test("updates pre-built provider using pipenv", async () => {
        await driver.exec("pipenv", ["install", INITIAL_PKG]);
        expect(driver.readLocalFile("Pipfile")).toContain(
          `cdktn-provider-local = "==12.0.0"`,
        );

        await driver.exec("cdktn", ["provider", "upgrade", UPGRADE_TARGET]);
        expect(driver.readLocalFile("Pipfile")).toContain(
          UPGRADED_PIPFILE_LINE,
        );
      });
    });

    describe("pip", () => {
      beforeAll(async () => {
        driver = new TestDriver(__dirname, {
          // disable version check: locally-installed cdktn-cli is 0.0.0 (from dist),
          // project pins a published cdktn version
          DISABLE_VERSION_CHECK: "true",
        });
        await driver.setupPythonProject();
        // Supress warning that Pipenv is running within a virtual environment
        driver.setEnv("PIPENV_VERBOSITY", "-1");
        driver.removeFile("Pipfile");

        await driver.createAndActivateVirtualEnv();

        driver.copyFile("cdktf-pip.json", "cdktf.json");
        driver.copyFiles("requirements.txt");
        driver.exec("pip", [
          "install",
          "--no-compile",
          "-r",
          "requirements.txt",
        ]);
      });

      test("updates pre-built provider using pip", async () => {
        await driver.exec("echo", [INITIAL_PKG, ">", "requirements.txt"]);
        expect(driver.readLocalFile("requirements.txt")).toContain(INITIAL_PKG);
        await driver.exec("pip", [
          "install",
          "--no-compile",
          "-r",
          "requirements.txt",
        ]);

        await driver.exec("cdktn", ["provider", "upgrade", UPGRADE_TARGET]);
        expect(driver.readLocalFile("requirements.txt")).toContain(
          UPGRADED_REQUIREMENTS_LINE,
        );
      });
    });
  });
});
