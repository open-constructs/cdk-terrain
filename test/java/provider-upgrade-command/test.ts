// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TestDriver } from "../../test-helper";

describe("provider upgrade command", () => {
  let driver: TestDriver;

  describe("pre-built", () => {
    beforeEach(async () => {
      driver = new TestDriver(__dirname, {
        CDKTN_OVERRIDE_VERSION: "0.23.1",
      }); // fake cdktn version for consistent provider version checks
      await driver.setupJavaProject();
    });

    test("installs pre-built provider using gradle", async () => {
      await driver.exec("cdktn", ["provider", "add", "random@=3.8.1"]);

      await driver.exec("cdktn", ["provider", "upgrade", "random@=3.9.0"]);

      expect(driver.readLocalFile("build.gradle")).not.toContain(
        "cdktn-provider-random:14.0.0",
      );
      expect(driver.readLocalFile("build.gradle")).toContain(
        "cdktn-provider-random:14.1.0",
      );
    }, 500_000);
  });
});
