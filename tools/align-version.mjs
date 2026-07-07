#!/usr/bin/env node
// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

//
// usage: align-version.mjs [SUFFIX]
//
// aligns package versions to the root package.json version
// this is executed in CI builds so artifacts include the actual version instead of 0.0.0
//
// if SUFFIX is provided, appends this to the version as-is
//

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const suffix = process.argv[2] ?? "";
const { version: rootVersion } = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
);
const version = `${rootVersion}${suffix}`;

// only rewrite the versions on disk; leave git and the working tree alone
const noSideEffects = [
  "--git-commit=false",
  "--git-tag=false",
  "--git-push=false",
  "--stage-changes=false",
];

execFileSync(
  "pnpm",
  ["exec", "nx", "release", "version", version, ...noSideEffects],
  { cwd: repoRoot, stdio: "inherit" },
);
