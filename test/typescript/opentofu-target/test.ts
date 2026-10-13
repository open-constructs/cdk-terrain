// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import { TestDriver, providerVersion } from "../../test-helper";

// The project declares an OpenTofu-only target. The matrix's other OpenTofu rows
// change only the CLI, so code that resolves registries from `targetVersions` is
// covered nowhere else (#494).
describe("project targeting OpenTofu", () => {
  const stack = "opentofu-target";
  let driver: TestDriver;

  const lockFile = () =>
    fs.readFileSync(
      path.join(driver.stackDirectory(stack), ".terraform.lock.hcl"),
      "utf8",
    );

  beforeAll(async () => {
    driver = new TestDriver(__dirname);
    await driver.setupTypescriptProject();
  }, 500_000);

  test("generates bindings from the OpenTofu registry", () => {
    const versions = JSON.parse(driver.readLocalFile(".gen/versions.json"));
    expect(versions).toEqual({
      "registry.opentofu.org/hashicorp/random": "3.6.0",
    });
  });

  test("links generated docs to the OpenTofu registry", () => {
    const provider = driver.readLocalFile(
      ".gen/providers/random/provider/index.ts",
    );
    expect(provider).toContain(
      "https://search.opentofu.org/provider/hashicorp/random/v3.6.0/docs",
    );
    expect(provider).not.toContain("registry.terraform.io/providers");
  });

  // A host here would pin the CLI to that registry.
  test("synthesizes the provider source without a registry host", async () => {
    await driver.synth();
    const synthesized = JSON.parse(driver.synthesizedStackContentsRaw(stack));
    expect(synthesized.terraform.required_providers.random.source).toBe(
      "hashicorp/random",
    );
  });

  test("deploys with the provider from the OpenTofu registry", async () => {
    const output = await driver.deploy([stack]);
    expect(output).not.toContain("registry.terraform.io");
    expect(lockFile()).toContain(
      'provider "registry.opentofu.org/hashicorp/random"',
    );
  }, 300_000);

  test("reports the version the provider was generated at", async () => {
    const { stdout } = await driver.exec("cdktn", [
      "provider",
      "list",
      "--json",
    ]);
    const list = JSON.parse(stdout.slice(stdout.indexOf("{")));
    expect(list.local).toEqual([
      expect.objectContaining({
        providerName: "random",
        providerVersion: "3.6.0",
      }),
    ]);
  });

  // Exercises the lock-file comparison: the bump has to be detected as needing
  // `init -upgrade`, which plain `init` would reject.
  test("upgrades the provider and redeploys at the new version", async () => {
    await driver.exec("cdktn", ["provider", "upgrade", "random@=3.6.1"]);
    const versions = JSON.parse(driver.readLocalFile(".gen/versions.json"));
    expect(providerVersion(versions, "hashicorp/random")).toBe("3.6.1");

    await driver.deploy([stack]);
    expect(lockFile()).toMatch(/version\s+=\s+"3\.6\.1"/);
  }, 500_000);
});
