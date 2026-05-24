/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

// Builds the GitHub Actions matrix for the examples workflow.
// Walks examples/ for package.json files named @examples/*, skips ones with
// a truthy "private" field (boolean true or the string "true"), and prints
// a JSON matrix. The base matrix runs every example against the default
// terraform version with `hclOutput=false`; `include:` entries add a single
// `hclOutput=true` smoke run per language binding so the HCL synth path is
// still covered without doubling the matrix.
//
// Runs without dependencies installed so the matrix step can be cheap.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Repository root. The script is invoked from the repo root in CI (and via
 * `node tools/build-example-matrix.mjs` locally), so `process.cwd()` is the
 * authoritative location without hard-coding the script's relative path.
 *
 * @type {string}
 */
const repoRoot = process.cwd();

/**
 * Recursively walks `dir`, collecting absolute paths of every `package.json`
 * found. Skips `node_modules` directories so installed dependencies don't
 * pollute the result.
 *
 * @param {string} dir Directory to walk.
 * @param {string[]} [results=[]] Accumulator for matched paths; pass when
 *   recursing, omit at the top-level call.
 * @returns {string[]} Absolute paths of every discovered `package.json`.
 */
function findPackageJsonFiles(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findPackageJsonFiles(full, results);
    } else if (entry.isFile() && entry.name === "package.json") {
      results.push(full);
    }
  }
  return results;
}

/**
 * Returns whether a parsed package.json is marked private. Tolerates the
 * boolean `true` and the string `"true"`
 *
 * @param {{ private?: boolean | string }} pkg Parsed package.json contents.
 * @returns {boolean} `true` if the package should be excluded from the matrix.
 */
function isPrivate(pkg) {
  return pkg.private === true || pkg.private === "true";
}

/**
 * Default Terraform version pulled from `.terraform.versions.json`. Used as
 * the single entry in the matrix's `terraform` axis so every example runs
 * against the project-wide default.
 *
 * @type {string}
 */
const tfDefault = JSON.parse(
  readFileSync(join(repoRoot, ".terraform.versions.json"), "utf8"),
).default;

/**
 * Sorted list of `@examples/*` workspace names that should appear in the
 * matrix. Workspaces with a truthy `private` field are excluded.
 *
 * @type {string[]}
 */
const targets = findPackageJsonFiles(join(repoRoot, "examples"))
  .map((file) => JSON.parse(readFileSync(file, "utf8")))
  .filter((pkg) => pkg.name && pkg.name.startsWith("@examples/"))
  .filter((pkg) => !isPrivate(pkg))
  .map((pkg) => pkg.name)
  .sort();

/**
 * Representative examples (one per language binding) that exercise the
 * `SYNTH_HCL_OUTPUT=true` synth code path. The HCL output mode lives in
 * `packages/cdktn/lib/{app,terraform-stack}.ts` and is orthogonal to the
 * example itself, so testing it on every example is redundant — one
 * smoke target per language is sufficient to catch a regression.
 *
 * @type {string[]}
 */
const hclSmokeTargets = [
  "@examples/csharp-aws",
  "@examples/go-docker",
  "@examples/java-aws",
  "@examples/python-aws",
  "@examples/typescript-aws-multiple-stacks",
];

const missingHclSmoke = hclSmokeTargets.filter((t) => !targets.includes(t));
if (missingHclSmoke.length > 0) {
  throw new Error(
    `HCL smoke targets missing from the example matrix: ${missingHclSmoke.join(", ")}. ` +
      `Update hclSmokeTargets in tools/build-example-matrix.mjs.`,
  );
}

/**
 * GitHub Actions matrix object. The base matrix runs every example with
 * `hclOutput=false`; the `include` entries add a single `hclOutput=true`
 * smoke run per language.
 *
 * @type {{
 *   target: string[],
 *   terraform: string[],
 *   hclOutput: boolean[],
 *   include: Array<{ target: string, terraform: string, hclOutput: boolean }>,
 * }}
 */
const matrix = {
  target: targets,
  terraform: [tfDefault],
  hclOutput: [false],
  include: hclSmokeTargets.map((target) => ({
    target,
    terraform: tfDefault,
    hclOutput: true,
  })),
};

process.stdout.write(JSON.stringify(matrix));
