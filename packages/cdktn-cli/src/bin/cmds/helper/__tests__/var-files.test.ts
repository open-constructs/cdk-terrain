/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { sanitizeVarFiles } from "../var-files";
import * as path from "path";
describe("sanitizeVarFiles", () => {
  it("adds files in right order", () => {
    const cwd = path.join(__dirname, "fixtures");
    expect(
      // sanitizeVarFiles returns real filesystem paths, so they are
      // backslash-separated on Windows. Normalize to "/" so one snapshot
      // covers every platform.
      sanitizeVarFiles(["foo.tfvars"], cwd).map((p) =>
        p.replace(cwd, "<rootDir>").split(path.sep).join(path.posix.sep),
      ),
    ).toMatchInlineSnapshot(`
      [
        "<rootDir>/terraform.tfvars",
        "<rootDir>/hey-there.auto.tfvars",
        "<rootDir>/foo.tfvars",
      ]
    `);
  });
});
