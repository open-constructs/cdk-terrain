// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TestDriver } from "../../test-helper";

/** PyPI version pin for the cdktn library installed into the test project. */
const CDKTN_PIN = "cdktn~=0.22.1";

/**
 * Provider added without `--force-local`, so it resolves to a pre-built
 * package. Picks Terraform local 2.7.0 so the resolver chooses
 * cdktn-provider-local 12.0.0.
 */
const PREBUILT_PROVIDER = "local@=2.7.0";

/** Terraform local version inside the pre-built package; surfaced in `provider list` output. */
const PREBUILT_PROVIDER_TF_VERSION = "2.7.0";

/** cdktn-provider-local package version resolved from {@link PREBUILT_PROVIDER}. */
const PREBUILT_PKG_VERSION = "12.0.0";

/** cdktn peer-dependency declared by {@link PREBUILT_PKG_VERSION}; surfaced in `provider list` output. */
const PREBUILT_CDKTN_PEER = "^0.22.0";

/**
 * Provider added with `--force-local`, bypassing the pre-built lookup. Any
 * Terraform provider works; `null` is small and stable.
 */
const LOCAL_PROVIDER = "null@=3.2.4";

/** Terraform null version expected to surface in `provider list` for {@link LOCAL_PROVIDER}. */
const LOCAL_PROVIDER_TF_VERSION = "3.2.4";

describe("provider list command", () => {
  let driver: TestDriver;
  beforeEach(async () => {
    driver = new TestDriver(__dirname, {
      // disable version check: locally-installed cdktn-cli is 0.0.0 (from dist),
      // project pins a published cdktn version
      DISABLE_VERSION_CHECK: "true",
      CI: "1",
    });
    await driver.setupPythonProject();

    await driver.exec("pipenv", ["install", CDKTN_PIN]);
  }, 500_000);

  describe("lists both local and prebuilt providers", () => {
    beforeEach(async () => {
      await driver.exec("cdktn", ["provider", "add", PREBUILT_PROVIDER]);

      await driver.exec("cdktn", [
        "provider",
        "add",
        LOCAL_PROVIDER,
        "--force-local",
      ]);
    });

    test("with json output", async () => {
      const res = await driver.exec("cdktn", ["provider", "list", "--json"]);

      const output = JSON.parse(res.stdout);

      expect(output).toHaveProperty("local");
      expect(output).toHaveProperty("prebuilt");
      expect(output.local).toHaveLength(1);
      expect(output.prebuilt).toHaveLength(1);

      expect(output.local[0]).toEqual(
        expect.objectContaining({
          providerName: "null",
          providerConstraint: "=3.2.4",
          providerVersion: LOCAL_PROVIDER_TF_VERSION,
        }),
      );

      expect(output.prebuilt[0]).toEqual(
        expect.objectContaining({
          packageName: "cdktn-provider-local",
          packageVersion: PREBUILT_PKG_VERSION,
          providerName: "local",
          providerVersion: PREBUILT_PROVIDER_TF_VERSION,
          cdktnVersion: PREBUILT_CDKTN_PEER,
        }),
      );
    }, 120_000);

    test("with tabular output", async () => {
      const res = await driver.exec("cdktn", ["provider", "list"]);

      expect(res.stdout).toMatchSnapshot();
    }, 120_000);
  });
});
