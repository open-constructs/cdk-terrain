#!/usr/bin/env node
/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */
// Generate and run the integration test of one provider.
// Set UPDATE_SNAPSHOTS to update the Jest snapshots.
//
// Usage:
//   node ./provider-tests/test-provider.mjs <provider>
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const provider = process.argv[2];
if (!provider) {
  console.error("provider name is required");
  process.exit(1);
}

const scriptdir = import.meta.dirname;
const testdir = join(scriptdir, "..");

function run(args, cwd) {
  console.log(`+ node ${args.join(" ")}`);
  const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run([join(scriptdir, "generate-provider-test.js"), provider], testdir);

const jestArgs = ["jest", `./provider-tests/providers/${provider}`];
if (process.env.UPDATE_SNAPSHOTS) jestArgs.push("-u");
run([join(testdir, "run-against-dist.mjs"), "npx", ...jestArgs], testdir);
