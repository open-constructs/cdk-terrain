// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  onPosix,
  onWindows,
  sanitizeTimestamps,
  TestDriver,
} from "../../test-helper";

describe("provider add command", () => {
  describe("local", () => {
    let driver: TestDriver;
    beforeEach(async () => {
      driver = new TestDriver(__dirname);
      await driver.setupGoProject();
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
            "hashicorp/null@~> 3.1.0",
            "hashicorp/local@=2.2.3",
          ]
        `);

        expect(res.stdout).toContain(
          `Local providers have been updated. Running cdktn get to update...`,
        );

        // This file currently is only created for TypeScript targets
        // we need to make "generateJsiiLanguage" copy that file to
        // the target directory for this to work
        // const genVersionsFile = JSON.parse(
        //   driver.readLocalFile("generated/versions.json")
        // );
        // expect(
        //   genVersionsFile["registry.terraform.io/hashicorp/local"]
        // ).toEqual("2.2.3");
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
                    "hashicorp/null@~> 3.1.0",
                    "hashicorp/local@=2.2.3",
                  ]
              `);

        expect(res.stdout).toContain(
          `Local providers have been updated. Running cdktn get to update...`,
        );

        const genVersionsFile = JSON.parse(
          driver.readLocalFile("generated/versions.json"),
        );
        expect(
          genVersionsFile["registry.terraform.io/hashicorp/local"],
        ).toEqual("2.2.3");
      },
      120_000,
    );
  });

  describe("pre-built", () => {
    let driver: TestDriver;

    beforeEach(async () => {
      driver = new TestDriver(__dirname, {
        CDKTN_OVERRIDE_VERSION: "0.23.1",
      }); // fake cdktn version for consistent provider version checks
      await driver.setupGoProject();
    });

    it("detects correct cdktn version", async () => {
      const res = await driver.exec("cdktn", ["debug"]);
      expect(res.stdout).toContain("cdktn: 0.23.1");
    });

    test("installs pre-built provider using go get", async () => {
      const res = await driver.exec("cdktn", [
        "provider",
        "add",
        "random@=3.9.0",
      ]);

      // no snapshot, as the output also contains logs from Go upgrading JSII dependencies which might
      // change in the future and would break this test
      expect(sanitizeTimestamps(res.stdout)).toContain(
        `[<TIMESTAMP>] [INFO] default - Checking whether pre-built provider exists for the following constraints:`,
      );

      expect(sanitizeTimestamps(res.stdout)).toContain(`provider: random
  version : =3.9.0
  language: go
  cdktn   : 0.23.1`);

      expect(sanitizeTimestamps(res.stdout)).toContain(
        `[<TIMESTAMP>] [INFO] default - Found pre-built provider.`,
      );

      expect(sanitizeTimestamps(res.stdout)).toContain(
        `Adding package github.com/cdktn-io/cdktn-provider-random-go/random @ 14.1.0`,
      );

      expect(sanitizeTimestamps(res.stdout)).toContain(
        "added github.com/cdktn-io/cdktn-provider-random-go/random/v14 v14.1.0",
      );
      expect(sanitizeTimestamps(res.stdout)).toContain("Package installed.");

      // go also prints to stderr, weird but 🤷
      expect(res.stderr).toContain(
        "added github.com/cdktn-io/cdktn-provider-random-go/random/v14 v14.1.0",
      );

      const goMod = driver.readLocalFile("go.mod");

      expect(goMod).toContain(
        "github.com/cdktn-io/cdktn-provider-random-go/random/v14 v14.1.0",
      );
    }, 180_000);
  });
});
