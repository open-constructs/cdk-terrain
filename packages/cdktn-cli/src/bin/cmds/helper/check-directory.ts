// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import { Errors, resolveConfigFile } from "@cdktn/commons";
export function isCdktfProjectDirectory(directory: string): boolean {
  try {
    const cdktfPath = resolveConfigFile(directory);
    const cdktf = JSON.parse(fs.readFileSync(cdktfPath, "utf-8"));
    return cdktf.language && cdktf.app;
  } catch {
    return false;
  }
}

export function throwIfNotProjectDirectory(directory = process.cwd()): void {
  if (!isCdktfProjectDirectory(directory)) {
    throw Errors.Usage(
      `${directory} is not a cdktf/cdktn project directory, no cdktn.json or cdktf.json found, or the config is missing language / app keys`,
    );
  }
}
