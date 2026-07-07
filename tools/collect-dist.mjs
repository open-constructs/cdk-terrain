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

// one absolute path per workspace package
const packageDirs = execFileSync("pnpm", ["--recursive", "exec", "pwd"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

for (const dir of packageDirs) {
  const src = join(dir, "dist");
  if (existsSync(src)) {
    console.log(`collecting from ${src}`);
    cpSync(src, destDir, { recursive: true, dereference: true });
  }
}
