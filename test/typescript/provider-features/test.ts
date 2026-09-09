// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TestDriver, onlyJson } from "../../test-helper";

// Runtime coverage for provider-schema features newer than the default tested
// Terraform versions can emit. This target is pinned - in `pinnedRuntimes` in
// tools/build-test-matrix.mjs - to current stable Terraform and OpenTofu, and
// is the first test in this repo to run against OpenTofu at all.
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

      // The generated binding renders as a Terraform/OpenTofu provider function
      // call rather than being resolved at synth time.
      expect(output).toContain("provider::time::rfc3339_parse");
      expect(output).toContain("2024-01-02T03:04:05Z");
    },
  );
});
