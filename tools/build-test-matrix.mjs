/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

// Builds the GitHub Actions matrix for the integration tests workflow. Discovers every integration test file via
// `npx jest --listTests` (so the jest config in test/jest.config.js is the source of truth), then emits a flattened
// `include` matrix entry per (target × terraform × hclOutput).
//
// hclOutput: true is only emitted for files that contain at least one HCL-positive decorator from test/test-helper.ts
// (`onlyHcl`, `onPosixWithHcl`, `onWindowsWithHcl`). Files using only `onlyJson` would skip every test in HCL mode, and
// files with no mode decorators produce identical results in both modes — running them twice is pure waste.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Repository root. Invoked from the repo root in CI and locally. */
const repoRoot = process.cwd();
const testDir = join(repoRoot, "test");

const versionsConfig = JSON.parse(
  readFileSync(join(repoRoot, ".terraform.versions.json"), "utf8"),
);

/** Tested Terraform versions from `.terraform.versions.json`. */
const tfVersions = versionsConfig.tested;

/** Binary name prefix per product. The CI image installs one binary per available version of each. */
const binaryPrefix = { terraform: "terraform", opentofu: "tofu" };

/** Versions of each product the CI image actually ships, used to validate pins below. */
const availableVersions = {
  terraform: versionsConfig.available,
  opentofu: versionsConfig.opentofu?.available ?? [],
};

/**
 * Tests that opt out of the default `tested` Terraform cross-product and run against an explicit list of runtimes
 * instead. Keyed by path relative to `test/`. Pinned versions must be in the matching `available` list.
 *
 * @type {Record<string, Array<{ product: "terraform" | "opentofu", version: string }>>}
 */
const pinnedRuntimes = {
  "typescript/provider-features/test.ts": [
    { product: "terraform", version: "1.16.1" },
    { product: "opentofu", version: "1.12.6" },
  ],
};

for (const [target, runtimes] of Object.entries(pinnedRuntimes)) {
  for (const { product, version } of runtimes) {
    if (!availableVersions[product]?.includes(version)) {
      throw new Error(
        `pinnedRuntimes["${target}"] pins ${product} ${version}, which is not in ` +
          `.terraform.versions.json ${product === "terraform" ? "available" : "opentofu.available"}, ` +
          `so the CI image has no ${binaryPrefix[product]}${version} binary.`,
      );
    }
  }
}

/**
 * Absolute paths of every integration test file, as resolved by jest's own config (including `testPathIgnorePatterns`
 * and `modulePathIgnorePatterns`).
 */
const absoluteTargets = execFileSync(
  "npx",
  ["jest", "--listTests", "--testPathIgnorePatterns=/provider-tests/"],
  { cwd: testDir, encoding: "utf8" },
)
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const testDirPrefix = `${testDir}/`;
const targets = absoluteTargets
  .map((p) => (p.startsWith(testDirPrefix) ? p.slice(testDirPrefix.length) : p))
  .sort();

/**
 * Matches test files that exercise the HCL synth path with real assertions. Keep in sync with the HCL-positive
 * decorators exported by `test/test-helper.ts`.
 */
const hclPositivePattern = /\bonlyHcl\b|\bon(?:Posix|Windows)WithHcl\b/;

/**
 * Determines whether a test file has any assertions that actually run when `SYNTH_HCL_OUTPUT=true`. Source-greps the
 * file for HCL-positive decorators rather than executing jest, so it is cheap enough to call for every target.
 *
 * @param {string} relPath Path relative to `test/`.
 * @returns {boolean} `true` if the file would run any assertion in HCL mode.
 */
function fileNeedsHclRun(relPath) {
  const contents = readFileSync(join(testDir, relPath), "utf8");
  return hclPositivePattern.test(contents);
}

/**
 * Flattened list of matrix entries consumed by `strategy.matrix.include` in the workflow. Each entry materialises one
 * `linux_integration` job for a given test file against a given CLI in a given synth output mode.
 *
 * @type {Array<{ target: string, terraform: string, binary: string, hclOutput: boolean }>}
 */
const include = [];
for (const target of targets) {
  const modes = fileNeedsHclRun(target) ? [false, true] : [false];
  const runtimes =
    pinnedRuntimes[target] ??
    tfVersions.map((version) => ({ product: "terraform", version }));
  for (const { product, version } of runtimes) {
    for (const hclOutput of modes) {
      include.push({
        target,
        terraform: version,
        binary: `${binaryPrefix[product]}${version}`,
        hclOutput,
      });
    }
  }
}

const tests = JSON.stringify({ include });
process.stdout.write(`${tests}\n`);

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `tests=${tests}\n`, { flag: "a" });
}
