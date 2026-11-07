// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import { TestDriver, onlyJson } from "../../test-helper";

// Runtime coverage for provider-schema features newer than the default tested
// Terraform versions can emit. Pinned to current stable Terraform and OpenTofu
// in `pinnedRuntimes` in tools/build-test-matrix.mjs.
describe("provider features", () => {
  let driver: TestDriver;

  beforeAll(async () => {
    driver = new TestDriver(__dirname);
    await driver.setupTypescriptProject();
    await driver.synth();
  }, 500_000);

  onlyJson(
    "binds provider-defined functions into the synthesized stack",
    () => {
      const output = driver
        .synthesizedStack("provider-functions")
        .output("parsed");

      // The generated binding renders as a provider function call.
      expect(output).toContain("provider::time::rfc3339_parse");
      expect(output).toContain("2024-01-02T03:04:05Z");
    },
  );

  // Placed last: it rewrites the project's declared targets.
  test("fails synth when targetVersions are below the provider function floor", async () => {
    const configPath = path.join(driver.workingDirectory, "cdktf.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    config.targetVersions = { terraform: ">=1.5.7", opentofu: ">=1.6.0" };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    let output = "";
    try {
      await driver.synth();
    } catch (e) {
      output = `${e.stderr}${e.stdout}`;
    }

    expect(output).toContain(
      "provider-defined functions (provider::time::rfc3339_parse) requires terraform >=1.8.0, but the project targets terraform >=1.5.7",
    );
    expect(output).toContain(
      "provider-defined functions (provider::time::rfc3339_parse) requires opentofu >=1.7.0, but the project targets opentofu >=1.6.0",
    );
  });
});
