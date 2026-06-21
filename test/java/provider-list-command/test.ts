// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TestDriver } from "../../test-helper";

describe("provider list command", () => {
  let driver: TestDriver;
  beforeEach(async () => {
    driver = new TestDriver(__dirname, {
      CDKTN_OVERRIDE_VERSION: "0.23.1",
      CI: "1",
    }); // fake cdktn version for consistent provider version checks
    await driver.setupJavaProject();
  }, 500_000);

  describe("lists both local and prebuilt providers", () => {
    beforeEach(async () => {
      await driver.exec("cdktn", ["provider", "add", "random@=3.8.1"]);

      await driver.exec("cdktn", [
        "provider",
        "add",
        "local@=2.2.3",
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
          providerName: "local",
          providerConstraint: "=2.2.3",
          providerVersion: "2.2.3",
        }),
      );

      expect(output.prebuilt[0]).toEqual(
        expect.objectContaining({
          packageName: "io.cdktn.cdktn-provider-random",
          packageVersion: "14.0.0",
          providerName: "random",
          providerVersion: "3.8.1",
          cdktnVersion: "^0.23.0",
        }),
      );
    }, 500_000);

    test("with tabular output", async () => {
      const res = await driver.exec("cdktn", ["provider", "list"]);

      expect(res.stdout).toMatchSnapshot();
    }, 120_000);
  });
});
