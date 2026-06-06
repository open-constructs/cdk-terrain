// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

/**
 * Creates a per-test-file temp-dir helper.
 *
 * Returns a `tmp(prefix)` function that creates a uniquely-named directory
 * under `os.tmpdir()` and tracks it. An `afterAll` hook is registered on
 * the calling test file's scope; when the file finishes running, every
 * tracked directory is removed (recursively, force).
 */
export function createTmpHelper(): (prefix: string) => string {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  return (prefix: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  };
}

/**
 * Check if all distribution files required for init() tests exist.
 * These tests require `pnpm package` to be run first to generate all language distributions.
 *
 * @param fromTestFile - Use __dirname from the test file calling this function
 * @returns true if all required dist files exist
 */
export function checkDistFilesExist(fromTestFile: string): boolean {
  const distPath = path.join(fromTestFile, "../../../../../../dist");

  const requiredFiles = [
    path.join(distPath, "js", "cdktn@0.0.0.jsii.tgz"),
    path.join(distPath, "js", "cdktn-cli-0.0.0.tgz"),
    path.join(distPath, "python", "cdktn-0.0.0-py3-none-any.whl"),
    path.join(distPath, "java", "io/cdktn/cdktn/0.0.0/cdktn-0.0.0.jar"),
    path.join(distPath, "dotnet", "Io.Cdktn.0.0.0.nupkg"),
    path.join(distPath, "go", "cdktn"),
  ];

  return requiredFiles.every((file) => fs.existsSync(file));
}

/**
 * Returns describe.skip with an informative message if dist files don't exist.
 * Use this for tests that require `pnpm package` to have been run.
 *
 * @param fromTestFile - Use __dirname from the test file calling this function
 * @returns describe or describe.skip based on whether dist files exist
 */
export function describeIfDistExists(fromTestFile: string) {
  const distFilesExist = checkDistFilesExist(fromTestFile);

  if (!distFilesExist) {
    console.warn(
      "\n⚠️  Skipping tests that require dist files. Run 'pnpm package' to enable these tests.\n" +
        "   Note: 'pnpm package' requires Maven (mvn) to be installed.\n",
    );
    return describe.skip;
  }

  return describe;
}
