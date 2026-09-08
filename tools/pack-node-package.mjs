// Copyright (c) OpenConstructs
// SPDX-License-Identifier: MPL-2.0
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

// pnpm resolves workspace: dependencies to release versions when packing.
mkdirSync("dist/js", { recursive: true });
execFileSync("pnpm", ["pack", "--pack-destination", "dist/js"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
