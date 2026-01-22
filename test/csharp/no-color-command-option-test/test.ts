// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as execa from "execa";
import * as hasAnsi from "has-ansi";
import { onPosix, TestDriver } from "../../test-helper";

describe("no-color option for cdktn deploy, diff, destroy", () => {
  let driver: TestDriver;
  beforeAll(async () => {
    driver = new TestDriver(__dirname, {
      JSII_SILENCE_WARNING_DEPRECATED_NODE_VERSION: "true",
    }); // this warning triggers our hasAnsi check
    await driver.setupCsharpProject();
  }, 500_000);

  onPosix("contains no color formatting in cdktn deploy", async () => {
    const result = await execa(
      "cdktn",
      ["deploy", "--auto-approve", "--no-color"],
      {
        env: driver.env,
        cwd: driver.workingDirectory,
      },
    );
    // These tests are sometimes flaky, therefore we log the result here to ensure we can debug it properly
    console.log(result.stdout);
    expect(hasAnsi(result.stdout)).toBe(false);
  });
  onPosix("contains no color formatting in cdktn diff", async () => {
    const result = await execa("cdktn", ["diff", "--no-color"], {
      env: driver.env,
      cwd: driver.workingDirectory,
    });
    // These tests are sometimes flaky, therefore we log the result here to ensure we can debug it properly
    console.log(result.stdout);
    expect(hasAnsi(result.stdout)).toBe(false);
  });
  onPosix("contains no color formatting in cdktn destroy", async () => {
    const result = await execa(
      "cdktn",
      ["destroy", "--auto-approve", "--no-color"],
      {
        env: driver.env,
        cwd: driver.workingDirectory,
      },
    );
    // These tests are sometimes flaky, therefore we log the result here to ensure we can debug it properly
    console.log(result.stdout);
    expect(hasAnsi(result.stdout)).toBe(false);
  });
});
