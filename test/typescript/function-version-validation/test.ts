// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import { TestDriver } from "../../test-helper";

describe("function version validation", () => {
  let driver: TestDriver;

  beforeAll(async () => {
    // a nonexistent binary proves the validation never executes a CLI:
    // synth outcomes depend only on the declared targetVersions
    driver = new TestDriver(__dirname, {
      TERRAFORM_BINARY_NAME: "cdktn-nonexistent-terraform-binary",
    });
    await driver.setupTypescriptProject();
  });

  afterEach(() => {
    delete driver.env.USE_CONSTRAINED_FUNCTION;
  });

  function setTargetVersions(targetVersions?: Record<string, string>) {
    const configPath = path.join(driver.workingDirectory, "cdktf.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (targetVersions) {
      config.targetVersions = targetVersions;
    } else {
      delete config.targetVersions;
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  test("universally available functions synth against any targets", async () => {
    setTargetVersions(undefined);

    const { stdout } = await driver.synth();

    expect(stdout).not.toContain("Validation failed");
  });

  test("constrained function fails against the default baseline targets", async () => {
    setTargetVersions(undefined);
    driver.env.USE_CONSTRAINED_FUNCTION = "true";

    try {
      await driver.synth();
      throw new Error("Expected synth to fail but no error was thrown");
    } catch (e) {
      const output = e.stderr.toString() + e.stdout.toString();
      expect(output).toContain(
        'Terraform function "issensitive" requires terraform >=1.8.0, but the project targets terraform >=1.5.7',
      );
    }
  });

  test("constrained function passes when the declared targets cover it", async () => {
    setTargetVersions({ terraform: ">=1.8.0", opentofu: ">=1.7.0" });
    driver.env.USE_CONSTRAINED_FUNCTION = "true";

    const { stdout } = await driver.synth();

    expect(stdout).not.toContain("Validation failed");
  });
});
