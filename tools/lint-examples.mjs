/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

// Lints examples, currently this includes:
// - making sure each example in /examples has a package.json describing how it can be run (i.e. by CI)
//    - making sure the name in the package.json matches @examples/<language>-<name_of_example>-<any-sub-directory>
//      (^ this ensures that we have clear names when we start measuring the build and synth performance of examples)
// - ... more as we might need it

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Filename whose presence in a directory marks that directory as a CDKTF project root. */
const CDKTF_CONFIG_FILE = "cdktf.json";

/**
 * Returns the names of immediate subdirectories of `rootDir`.
 *
 * @param {string} rootDir Absolute path to the directory to inspect.
 * @returns {string[]} Subdirectory names (not paths), unsorted.
 */
function getChildDirs(rootDir) {
  return readdirSync(rootDir).filter((file) =>
    statSync(resolve(rootDir, file)).isDirectory(),
  );
}

/**
 * Whether `dir` is the root of a CDKTF or example project, identified by th presence of either `cdktf.json` or
 * `package.json` directly in it.
 *
 * @param {string} dir Absolute path to the directory to inspect.
 * @returns {boolean} `true` if the directory looks like a project root.
 */
function isCdktfOrExampleProject(dir) {
  return readdirSync(dir).some(
    (file) => file === CDKTF_CONFIG_FILE || file === "package.json",
  );
}

/**
 * Walks `root` recursively and collects every directory that looks like a CDKTF or example project root.
 * Descend stops at each project root, so nested sub-projects under an already-matched directory are not returned.
 *
 * @param {string} root Absolute path to the directory to walk.
 * @returns {string[]} Absolute paths of every discovered project root.
 */
function collectCdktfOrExampleProjectDirs(root) {
  const projectDirs = [];

  if (isCdktfOrExampleProject(root)) {
    projectDirs.push(root);
  } else {
    const childDirs = getChildDirs(root);
    projectDirs.push(
      ...childDirs.flatMap((childDir) =>
        collectCdktfOrExampleProjectDirs(resolve(root, childDir)),
      ),
    );
  }

  return projectDirs;
}

/** Absolute path to the repository root, derived from this script's location. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Reports a lint failure. Under GitHub Actions (`GITHUB_ACTIONS=true`) the message is emitted as a
 * `::error file=...::` workflow command so it surfaces as a PR annotation; otherwise it's a plain stderr line.
 *
 * @param {string} file Repository-relative path to the offending file. Used
 *   as the `file=` argument of the workflow command.
 * @param {string} message Human-readable error message. Carriage returns and
 *   newlines are escaped for the workflow command format.
 * @returns {void}
 */
function reportError(file, message) {
  if (process.env.GITHUB_ACTIONS === "true") {
    const escaped = message.replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.error(`::error file=${file}::${escaped}`);
  } else {
    console.error(`Error in ${file}: ${message}`);
  }
}

/**
 * Repository-relative paths of every example project under `examples/`,
 * e.g. `['examples/typescript/docker', 'examples/typescript/google']`.
 */
const exampleProjects = collectCdktfOrExampleProjectDirs(
  resolve(REPO_ROOT, "examples"),
).map((p) => p.replace(REPO_ROOT + "/", ""));

/**
 * Output of `lerna list --all --json` — every workspace package lerna can see, with `name`, `location`,
 * `version`, and `private` fields. Used to cross-check that each example directory is registered as a lerna
 * package.
 *
 * @type {Array<{ name: string, location: string, version: string, private: boolean }>}
 */
const knownToLerna = JSON.parse(
  execSync("npx lerna list --all --json").toString(),
);

let failedCheck = false;
for (const example of exampleProjects) {
  const expectedPackageName = `@examples/${example
    .replace("examples/", "")
    .replace(/\//g, "-")}`;
  const packageJsonPath = resolve(REPO_ROOT, example, "package.json");

  if (!existsSync(packageJsonPath)) {
    failedCheck = true;
    reportError(
      example,
      `Found example in directory '${example}' but there is no package.json.`,
    );
    continue;
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath));

  if (packageJson.name !== expectedPackageName) {
    failedCheck = true;
    reportError(
      join(example, "package.json"),
      `package.json name is "${packageJson.name}" but should be "${expectedPackageName}"`,
    );
    continue;
  }

  const lernaEntry = knownToLerna.find((e) => e.name === expectedPackageName);

  if (!lernaEntry) {
    reportError(
      join(example, "package.json"),
      `Example has a package.json with the right name but "npx lerna list --all" does not recognize "${expectedPackageName}".`,
    );
    failedCheck = true;
    continue;
  }

  const configJsonPath = resolve(REPO_ROOT, example, "cdktf.json");

  // We only check examples that have a cdktf.json (E.g. the Java Gradle example does not have a cdktf.json in its main directory)
  if (!existsSync(configJsonPath)) {
    continue;
  }
  const configJson = JSON.parse(readFileSync(configJsonPath));

  if (configJson.projectId) {
    failedCheck = true;
    reportError(
      join(example, "cdktf.json"),
      `cdktf.json defines projectId "${configJson.projectId}". Please remove that key.`,
    );
    continue;
  }

  if (configJson.userId) {
    failedCheck = true;
    reportError(
      join(example, "cdktf.json"),
      `cdktf.json defines userId "${configJson.userId}". Please remove that key.`,
    );
    continue;
  }

  if (
    configJson.sendCrashReports &&
    (configJson.sendCrashReports === true ||
      configJson.sendCrashReports !== "false")
  ) {
    failedCheck = true;
    reportError(
      join(example, "cdktf.json"),
      `cdktf.json defines a truthy sendCrashReports "${configJson.sendCrashReports}". Please remove that key or set it to false / "false".`,
    );
    continue;
  }
}

if (failedCheck) {
  console.log(
    "Linting the examples failed. One or more examples failed the validation rules. See stderr for more information about them.",
  );
  process.exit(1);
} else {
  console.log("Linting the examples succeeded.");
}
