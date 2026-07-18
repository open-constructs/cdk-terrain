// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TestDriver, sanitizeTimestamps } from "../../test-helper";

describe("provider add command", () => {
  let driver: TestDriver;

  describe("pre-built", () => {
    beforeEach(async () => {
      driver = new TestDriver(__dirname, {
        DISABLE_VERSION_CHECK: "true",
      }); // reset CDKTF_DIST set by run-against-dist script & disable version check as we have to use an older version of cdktn-cli
      await driver.setupJavaProject();
      await driver.addGradleDependency("io.cdktn:cdktn:0.23.1");
    });

    it("detects correct cdktn version", async () => {
      const res = await driver.exec("cdktn", ["debug"]);
      expect(res.stdout).toContain("cdktn: 0.23.1");
    });

    test("installs pre-built provider using gradle", async () => {
      const res = await driver.exec("cdktn", [
        "provider",
        "add",
        "random@=3.9.0",
      ]);
      expect(sanitizeTimestamps(res.stdout)).toMatchInlineSnapshot(`
        "[<TIMESTAMP>] [INFO] default - Checking whether pre-built provider exists for the following constraints:
          provider: random
          version : =3.9.0
          language: java
          cdktn   : 0.23.1


        [<TIMESTAMP>] [INFO] default - Found pre-built provider.
        "
      `);
      expect(res.stderr).toBe("");

      const proj = driver.readLocalFile("build.gradle");

      expect(proj).toContain("cdktn-provider-random:14.1.0");
    }, 500_000);
  });
});
