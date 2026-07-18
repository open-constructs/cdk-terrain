// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TestDriver } from "../../test-helper";

describe("provider upgrade command", () => {
  describe("pre-built", () => {
    let driver: TestDriver;

    beforeEach(async () => {
      driver = new TestDriver(__dirname, {
        DISABLE_VERSION_CHECK: "true",
      }); // reset CDKTF_DIST set by run-against-dist script & disable version check as we have to use an older version of cdktn-cli
      await driver.setupGoProject();

      await driver.exec("go", [
        "get",
        "github.com/open-constructs/cdk-terrain-go/cdktn@v0.23.1,
      ]);
    });

    test("installs pre-built provider using go get", async () => {
      await driver.exec("go", [
        "get",
        "github.com/cdktn-io/cdktn-provider-random-go/random/v14@v14.0.1",
      ]);

      expect(driver.readLocalFile("go.mod")).toContain(
        "github.com/cdktn-io/cdktn-provider-random-go/random/v14 v14.0.1",
      );
      await driver.exec("cdktn", ["provider", "upgrade", "random@=3.9.0"]);
      expect(driver.readLocalFile("go.mod")).not.toContain(
        "github.com/cdktn-io/cdktn-provider-random-go/random/v14 v14.0.1",
      );
      expect(driver.readLocalFile("go.mod")).toContain(
        "github.com/cdktn-io/cdktn-provider-random-go/random/v14 v14.1.0",
      );
    }, 180_000);
  });
});
