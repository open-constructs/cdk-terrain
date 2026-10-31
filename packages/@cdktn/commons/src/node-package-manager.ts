// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as path from "path";
import * as semver from "semver";

export const YARN_TRACKING_ISSUE_URL =
  "https://github.com/open-constructs/cdk-terrain/issues/492";

/**
 * Yarn classic (1.x) and Yarn Berry (2+) share the `yarn` command but differ in CLI surface, so they are told apart.
 */
export type NodePackageManagerName = "npm" | "pnpm" | "yarn" | "yarn-berry";

/**
 * The command that drives a project managed by the given package manager.
 */
export function nodePackageManagerCommand(
  packageManager: NodePackageManagerName,
): "npm" | "pnpm" | "yarn" {
  return packageManager === "yarn-berry" ? "yarn" : packageManager;
}

/**
 * Detects the package manager of the Node.js project in `dir`. An explicit `packageManager` field (corepack) wins
 * over lockfile probing, since it is a deliberate declaration.
 */
export function detectNodePackageManager(dir: string): NodePackageManagerName {
  let declared: string | undefined;
  try {
    declared = fs.readJsonSync(path.join(dir, "package.json"))?.packageManager;
  } catch {
    // no or unreadable package.json - fall through to lockfile probing
  }

  if (typeof declared === "string") {
    const at = declared.indexOf("@");
    const name = at === -1 ? declared : declared.slice(0, at);
    const version = at === -1 ? "" : declared.slice(at + 1);
    if (name === "npm" || name === "pnpm") {
      return name;
    }
    if (name === "yarn") {
      return semver.major(semver.coerce(version) ?? "1.0.0") >= 2
        ? "yarn-berry"
        : "yarn";
    }
  }

  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (fs.existsSync(path.join(dir, ".yarnrc.yml"))) {
    return "yarn-berry";
  }
  if (fs.existsSync(path.join(dir, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}
