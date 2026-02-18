// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";

module.exports = async function globalTeardown() {
  const fixturesDir = process.env.HCL2CDK_FIXTURES_DIR;
  if (fixturesDir) {
    console.log(`[globalTeardown] Cleaning up fixtures at ${fixturesDir}`);
    await fs.remove(fixturesDir);
  }
};
