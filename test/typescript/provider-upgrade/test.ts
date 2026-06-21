// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TestDriver } from "../../test-helper";

describe("upgrade pre-built provider", () => {
  let driver: TestDriver;

  beforeAll(async () => {
    driver = new TestDriver(__dirname);
    await driver.setupTypescriptProject();
  });

  test("initial add", async () => {
    await driver.exec("npm", [
      "install",
      "@cdktn/provider-azuread@15.0.0",
      "--force",
    ]);
    await driver.diff();
  });

  test("update version", async () => {
    await driver.exec("npm", [
      "install",
      "@cdktn/provider-azuread@16.0.0",
      "--force",
    ]);
    await driver.diff();
  });
});
