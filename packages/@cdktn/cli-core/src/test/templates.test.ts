// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { readFileSync, readdirSync } from "fs-extra";
import * as path from "path";
import { CODE_MARKER } from "@cdktn/hcl2cdk";

const templatesDir = path.resolve(__dirname, "..", "..", "templates");

describe("Templates", () => {
  describe("Typescript", () => {
    it("main.ts should contain the '// define resources here' mark", () => {
      expect(
        readFileSync(path.join(templatesDir, "typescript", "main.ts"), "utf8"),
      ).toContain(CODE_MARKER);
    });
  });

  // `typescript-pnpm` overlays the `typescript` template, so it must carry only the files that actually differ -
  // anything else silently shadows the base and has to be kept in sync by hand.
  describe("typescript-pnpm", () => {
    const template = "typescript-pnpm";

    it("only overlays the files that differ from the base template", () => {
      expect(readdirSync(path.join(templatesDir, template)).sort()).toEqual([
        ".hooks.sscaff.js",
        "cdktf.json",
        "help",
        "package.json",
        "pnpm-workspace.yaml",
      ]);
    });

    it.each(["cdktf.json", "help", "package.json"])(
      "%s drives the project with its own package manager",
      (file) => {
        const contents = readFileSync(
          path.join(templatesDir, template, file),
          "utf8",
        );

        expect(contents).toContain("pnpm");
        // The npmjs.com search URL is a registry link rather than a command, so it legitimately survives.
        expect(
          contents.replace(/https:\/\/www\.npmjs\.com\S*/g, ""),
        ).not.toMatch(/\bnpm (run|install|i) /);
      },
    );
  });
});
