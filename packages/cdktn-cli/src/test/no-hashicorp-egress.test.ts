// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as path from "path";

// FR-001 / SC-007 (002-remove-hashicorp-telemetry): no active code may
// reference the HashiCorp checkpoint endpoint. Copyright headers are fine
// (they don't contain the hostname); this test scans every TypeScript
// source in the workspace packages and, when present, the built bundle.

const HASHICORP_ENDPOINT = "checkpoint-api.hashicorp.com";
const packagesRoot = path.resolve(__dirname, "../../..");

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("no HashiCorp checkpoint egress", () => {
  it("no workspace source references the checkpoint endpoint", () => {
    const srcDirs = [
      ...fs
        .readdirSync(packagesRoot)
        .map((p) => path.join(packagesRoot, p, "src")),
      ...fs
        .readdirSync(path.join(packagesRoot, "@cdktn"))
        .map((p) => path.join(packagesRoot, "@cdktn", p, "src")),
    ].filter((p) => fs.existsSync(p));

    const offenders = srcDirs.flatMap(collectSourceFiles).filter(
      (file) =>
        // test files may reference the endpoint to assert its absence
        // (this file, and cli-core's nock canary); FR-001 is about
        // active code
        !/\.test\.(ts|tsx)$/.test(file) &&
        fs.readFileSync(file, "utf8").includes(HASHICORP_ENDPOINT),
    );

    expect(offenders).toEqual([]);
  });

  it("the built CLI bundle has zero checkpoint endpoint references (when built)", () => {
    const bundle = path.resolve(__dirname, "../../bundle/bin/cdktn.js");
    if (!fs.existsSync(bundle)) {
      console.log("bundle not built, skipping bundle scan");
      return;
    }
    expect(fs.readFileSync(bundle, "utf8").includes(HASHICORP_ENDPOINT)).toBe(
      false,
    );
  });
});
