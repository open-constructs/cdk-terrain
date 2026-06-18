// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TestDriver } from "../../test-helper";

/**
 * Specific cdktn library version installed into the test project. Asserted in
 * `cdktn debug` output, so it is kept separate from the PyPI pin string.
 */
const CDKTN_VERSION = "0.22.1";

/** PyPI version pin built from {@link CDKTN_VERSION}. */
const CDKTN_PIN = `cdktn~=${CDKTN_VERSION}`;

/**
 * Provider source + Terraform version passed to `cdktn provider add`. Picks
 * Terraform local 2.7.0 so the resolver chooses cdktn-provider-local 12.0.0.
 */
const PROVIDER_TO_ADD = "local@=2.7.0";

/** Expected cdktn-provider-local package version resolved from {@link PROVIDER_TO_ADD}. */
const EXPECTED_PKG_VERSION = "12.0.0";

describe("provider add command", () => {
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

      it("detects correct cdktn version", async () => {
        const res = await driver.exec("cdktn", ["debug"]);
        expect(res.stdout).toContain(`cdktn: ${CDKTN_VERSION}`);
      });

      test("installs pre-built provider using pipenv", async () => {
        const res = await driver.exec("cdktn", [
          "provider",
          "add",
          PROVIDER_TO_ADD,
        ]);

        expect(res.stdout).toContain(
          `Installing package cdktn-provider-local @ ${EXPECTED_PKG_VERSION} using pipenv.`,
        );
        expect(res.stderr).toBe("");

        const pipfile = driver.readLocalFile("Pipfile");

        expect(pipfile).toContain(
          `cdktn-provider-local = "~=${EXPECTED_PKG_VERSION}"`,
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

      it("detects correct cdktn version", async () => {
        const res = await driver.exec("cdktn", ["debug"]);
        expect(res.stdout).toContain(`cdktn: ${CDKTN_VERSION}`);
      });

      test("installs pre-built provider using pipenv", async () => {
        const res = await driver.exec("cdktn", [
          "provider",
          "add",
          PROVIDER_TO_ADD,
        ]);

        expect(res.stdout).toContain(
          `Installing package cdktn-provider-local @ ${EXPECTED_PKG_VERSION} using pip.`,
        );
        expect(res.stderr).toBe("");

        const requirements = driver.readLocalFile("requirements.txt");

        expect(requirements).toContain(
          `cdktn-provider-local~=${EXPECTED_PKG_VERSION}`,
        );
      });
    });
  });
});
