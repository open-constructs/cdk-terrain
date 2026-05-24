// @ts-check
/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 *
 * Aggregates per-package jest coverage into a GitHub-flavoured markdown
 * table for display in `$GITHUB_STEP_SUMMARY`.
 *
 * Each converted package writes its own `coverage-summary.json` (via the
 * `json-summary` reporter configured in the root `jest.preset.js`) under
 * `packages/<scope>/<name>/test-output/jest/coverage/`. Jest itself has no
 * cross-project aggregator, so this script walks the workspace, reads the
 * `total` block from every summary file produced by the current run, and
 * prints a single sorted markdown table to stdout.
 *
 * Used by `.github/workflows/pr-unit.yml` and `.github/workflows/unit.yml`:
 *
 *     - name: Coverage summary
 *       if: always()
 *       run: node tools/coverage-summary.mjs >> "$GITHUB_STEP_SUMMARY"
 *
 * Run locally after `npx nx test <project> -- --coverage` to preview the
 * markdown that CI will render. Prints a placeholder when no packages
 * produced coverage (e.g. an `nx affected` run that selected nothing).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Recursively scan a directory tree for `coverage-summary.json` files emitted
 * by jest under a `test-output/jest/coverage/` path.
 *
 * @param {string} root - Directory to walk (relative or absolute).
 * @returns {string[]} Absolute or relative paths to each summary file found.
 */
function findSummaries(root) {
  /** @type {string[]} */
  const out = [];

  /** @param {string} dir */
  function walk(dir) {
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (
        e.name === "coverage-summary.json" &&
        full.includes(path.join("test-output", "jest", "coverage"))
      ) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

/**
 * Derive a human-readable package label from a summary file path.
 * Given `packages/<scope>/<name>/test-output/jest/coverage/coverage-summary.json`
 * returns `<scope>/<name>` (or `<name>` for unscoped packages).
 *
 * @param {string} summaryPath - Path to a `coverage-summary.json` file.
 * @returns {string} Package label.
 */
function packageName(summaryPath) {
  const rel = path.relative("packages", summaryPath);
  return rel.split(path.join("test-output", "jest"))[0].replace(/[/\\]$/, "");
}

/**
 * @typedef {Object} CoverageRow
 * @property {string} pkg - Package label (e.g. `@cdktn/commons`).
 * @property {number} s - Statements percentage.
 * @property {number} b - Branches percentage.
 * @property {number} f - Functions percentage.
 * @property {number} l - Lines percentage.
 */

/**
 * Build a coverage row from a single jest summary file.
 *
 * @param {string} file - Path to a `coverage-summary.json` file.
 * @returns {CoverageRow}
 */
function rowFromSummary(file) {
  const total = JSON.parse(fs.readFileSync(file, "utf8")).total;
  return {
    pkg: packageName(file),
    s: total.statements.pct,
    b: total.branches.pct,
    f: total.functions.pct,
    l: total.lines.pct,
  };
}

/**
 * Render the markdown summary for the given coverage rows. Returns a friendly
 * placeholder when no rows are present (e.g. no affected packages had tests).
 *
 * @param {CoverageRow[]} rows
 * @returns {string} Markdown ready for `$GITHUB_STEP_SUMMARY`.
 */
function renderMarkdown(rows) {
  if (rows.length === 0) {
    return "## Coverage\n\n_No coverage data produced (no affected packages with tests)._";
  }
  const sorted = [...rows].sort((a, b) => a.pkg.localeCompare(b.pkg));
  return [
    "## Coverage",
    "",
    "| Package | Statements | Branches | Functions | Lines |",
    "|---|---:|---:|---:|---:|",
    ...sorted.map(
      (r) => `| ${r.pkg} | ${r.s}% | ${r.b}% | ${r.f}% | ${r.l}% |`,
    ),
  ].join("\n");
}

/**
 * True if every coverage metric on the row is a real number. Jest writes
 * `"Unknown"` (a string) for packages with no tests under `passWithNoTests`,
 * which makes the row noise rather than signal.
 *
 * @param {CoverageRow} row
 * @returns {boolean}
 */
function hasNumericCoverage(row) {
  return [row.s, row.b, row.f, row.l].every((v) => typeof v === "number");
}

const rows = findSummaries("packages")
  .map(rowFromSummary)
  .filter(hasNumericCoverage);
console.log(renderMarkdown(rows));
