// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectNodePackageManager } from "./node-package-manager";

function pkg(packageManager: string) {
  return JSON.stringify({ packageManager });
}

function projectWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "cdktn-pm-test-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

describe("detectNodePackageManager", () => {
  it.each<[string, Record<string, string>, string]>([
    ["npm field", { "package.json": pkg("npm@10.9.0") }, "npm"],
    [
      "pnpm field over a conflicting lockfile",
      { "package.json": pkg("pnpm@11.5.2"), "yarn.lock": "" },
      "pnpm",
    ],
    ["yarn@1 field", { "package.json": pkg("yarn@1.22.22") }, "yarn"],
    [
      "yarn@4 field",
      { "package.json": pkg("yarn@4.5.0+sha512.abc") },
      "yarn-berry",
    ],
    [
      "yarn field pinned to a scoped registry URL",
      {
        "package.json": pkg(
          "yarn@https://registry.npmjs.org/@yarnpkg/cli-dist/-/cli-dist-4.1.0.tgz",
        ),
      },
      "yarn-berry",
    ],
    ["pnpm-lock.yaml", { "pnpm-lock.yaml": "" }, "pnpm"],
    ["yarn.lock alone", { "yarn.lock": "" }, "yarn"],
    [
      "yarn.lock with .yarnrc.yml",
      { "yarn.lock": "", ".yarnrc.yml": "" },
      "yarn-berry",
    ],
    ["nothing", {}, "npm"],
  ])("%s => %s", (_, files, expected) => {
    expect(detectNodePackageManager(projectWith(files))).toBe(expected);
  });
});
