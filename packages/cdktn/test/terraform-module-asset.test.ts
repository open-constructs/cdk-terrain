/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Testing } from "../src/testing";
import { TerraformStack } from "../src/terraform-stack";
import {
  findLowestCommonPath,
  TerraformModuleAsset,
} from "../src/terraform-module-asset";
import { describeIfSymlinks } from "./helper/capabilities";

describe("TerraformModuleAsset", () => {
  // The fixture builds a directory symlink in beforeEach, so the whole block
  // depends on symlink creation being permitted.
  describeIfSymlinks("module source copying (#320)", () => {
    let moduleDir: string;

    beforeEach(() => {
      moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-module-"));
      fs.writeFileSync(path.join(moduleDir, "main.tf"), "");
      fs.mkdirSync(path.join(moduleDir, "shared"));
      fs.writeFileSync(path.join(moduleDir, "shared", "vars.tf"), "");
      // a directory symlink previously hit copyFileSync -> EISDIR
      fs.symlinkSync("shared", path.join(moduleDir, "link"));
    });

    afterEach(() => {
      fs.rmSync(moduleDir, { recursive: true, force: true });
    });

    it("copies module sources containing directory symlinks", () => {
      const app = Testing.app({
        context: {
          cdktfRelativeModules: [path.relative(process.cwd(), moduleDir)],
        },
      });
      const stack = new TerraformStack(app, "stack");

      expect(
        () => new TerraformModuleAsset(stack, "module-asset"),
      ).not.toThrow();
    });
  });

  describe("findLowestCommonPath", () => {
    it.each([
      { paths: [], expected: undefined },
      { paths: ["./"], expected: "." },
      { paths: ["./foo/bar", "./foo/baz", "./foo"], expected: "foo" },
      { paths: ["../fuzz", "./foo/baz", "./foo/"], expected: ".." },
    ])(
      "should find the lowest common path for $paths expecting $expected",
      ({
        paths,
        expected,
      }: {
        paths: string[];
        expected: string | undefined;
      }) => {
        expect(findLowestCommonPath(paths)).toEqual(expected);
      },
    );
  });
});
