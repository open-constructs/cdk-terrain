// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TestDriver } from "../../test-helper";

describe("provider upgrade command", () => {
  let driver: TestDriver;

  describe("pre-built", () => {
    beforeEach(async () => {
      driver = new TestDriver(__dirname, {
        DISABLE_VERSION_CHECK: "true",
      }); // reset CDKTF_DIST set by run-against-dist script & disable version check as we have to use an older version of cdktn-cli
      await driver.setupJavaProject();
      await driver.addGradleDependency("io.cdktn:cdktn:0.23.1");
    });

    test("installs pre-built provider using gradle", async () => {
      await driver.exec("cdktn", ["provider", "add", "dns@=3.6.0"]);

      await driver.exec("cdktn", ["provider", "upgrade", "dns@=3.6.1"]);

      expect(driver.readLocalFile("build.gradle")).not.toContain(
        "cdktn-provider-dns:12.1.0",
      );
      expect(driver.readLocalFile("build.gradle")).toContain(
        "cdktn-provider-dns:12.1.1",
      );
    }, 500_000);
  });
});
