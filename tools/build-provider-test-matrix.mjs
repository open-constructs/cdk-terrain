/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

// Builds the GitHub Actions matrix for the provider integration tests workflow. Each provider listed in
// `test/provider-tests/providers.json` is materialised as a separate matrix entry by `test-provider.sh`, which copies
// `test/provider-tests/template/test.ts` into `test/provider-tests/providers/<name>/`.
//
// Because every provider uses the same template, the HCL synth path's coverage is a property of the template, not of
// the individual provider. We grep the template for HCL-positive decorators (`onlyHcl`, `onPosixWithHcl`,
// `onWindowsWithHcl`) and only emit `hclOutput: true` entries when at least one is present. Today the template uses
// only `onlyJson`, so the HCL dimension is dropped entirely; if it ever gains real HCL coverage the matrix doubles
// back automatically.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Repository root. Invoked from the repo root in CI and locally. */
const repoRoot = process.cwd();

/** Ordered list of provider keys (e.g. `aws`, `azurerm`) that participate in the provider integration matrix. */
const providers = Object.keys(
  JSON.parse(
    readFileSync(join(repoRoot, "test/provider-tests/providers.json"), "utf8"),
  ),
).sort();

/**
 * Matches test files that exercise the HCL synth path with real assertions. Kept identical to the regex used in
 * `tools/build-test-matrix.mjs` so the two workflows stay consistent.
 */
const hclPositivePattern = /\bonlyHcl\b|\bon(?:Posix|Windows)WithHcl\b/;

const templatePath = join(repoRoot, "test/provider-tests/template/test.ts");
const templateNeedsHcl = hclPositivePattern.test(
  readFileSync(templatePath, "utf8"),
);

const modes = templateNeedsHcl ? [false, true] : [false];

/**
 * Flattened list of matrix entries consumed by `strategy.matrix.include` in the workflow. One entry materialises one
 * `linux_provider` (and, when enabled, `windows_provider`) job for a given provider in a given synth output mode.
 *
 * @type {Array<{ target: string, hclOutput: boolean }>}
 */
const include = [];
for (const target of providers) {
  for (const hclOutput of modes) {
    include.push({ target, hclOutput });
  }
}

const tests = JSON.stringify({ include });
process.stdout.write(`${tests}\n`);

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `tests=${tests}\n`, { flag: "a" });
}
