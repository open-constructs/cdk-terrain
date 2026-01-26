// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TestDriver, onlyHcl, onlyJson } from "../../test-helper";

describe("java full integration", () => {
  let driver: TestDriver;

  beforeAll(async () => {
    driver = new TestDriver(__dirname);
    await driver.setupJavaProject();
  });

  test("debug command", async () => {
    driver.setEnv("CDKTF_LOG_LEVEL", "debug");
    await driver.exec(`cdktn debug --json`);
    driver.setEnv("CDKTF_LOG_LEVEL", "warning");
    const { stdout } = await driver.exec(`cdktn debug --json`);
    const { cdktn, constructs } = JSON.parse(stdout);
    expect(cdktn.length).not.toBe(0);
    expect(constructs.length).not.toBe(0);
  });

  onlyJson("synth generates JSON", async () => {
    await driver.synth();
    expect(driver.synthesizedStack("java-simple").toString()).toMatchSnapshot();
  });

  onlyHcl("synth generates HCL", async () => {
    await driver.synth();
    expect(
      driver.synthesizedStackContentsRaw("java-simple").toString(),
    ).toMatchSnapshot();
  });
});
