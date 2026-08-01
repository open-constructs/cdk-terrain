#!/usr/bin/env node
// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

//
// Collects every workspace package's `dist/` directory into a single top-level
// `dist/` at the repo root, ready for publishing. Symlinks are dereferenced so
// the collected tree is self-contained.
//

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(repoRoot, "dist");

rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });

// One absolute path per workspace package.
//
// `pnpm --recursive exec pwd` is not portable: `pwd` is a Unix command with no
// cmd.exe equivalent, and on Windows pnpm is a .cmd shim that Node cannot spawn
// without a shell. Ask pnpm for the paths as JSON instead.
const packageDirs = JSON.parse(
  execFileSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // cmd.exe resolves the pnpm shim; harmless no-op on other platforms.
    shell: process.platform === "win32",
  }),
)
  .map((pkg) => pkg.path)
  // Skip the workspace root: its `dist/` is the destination we collect into.
  .filter((dir) => dir && resolve(dir) !== repoRoot);

for (const dir of packageDirs) {
  const src = join(dir, "dist");
  if (existsSync(src)) {
    console.log(`collecting from ${src}`);
    cpSync(src, destDir, { recursive: true, dereference: true });
  }
}
