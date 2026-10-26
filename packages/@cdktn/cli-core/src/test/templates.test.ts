// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { existsSync, readFileSync, readdirSync } from "fs-extra";
import * as path from "path";
import { CODE_MARKER } from "@cdktn/hcl2cdk";

const templatesDir = path.resolve(__dirname, "..", "..", "templates");
// Variants such as typescript-pnpm carry no cdktf.json; they ship their base's files.
const baseTemplates = readdirSync(templatesDir).filter((name) =>
  existsSync(path.join(templatesDir, name, "cdktf.json")),
);

describe("Templates", () => {
  describe("Typescript", () => {
    it("main.ts should contain the '// define resources here' mark", () => {
      expect(
        readFileSync(path.join(templatesDir, "typescript", "main.ts"), "utf8"),
      ).toContain(CODE_MARKER);
    });
  });

  // Every scaffolded project points coding agents at the docs MCP server; init writes the matching .mcp.json.
  describe.each(baseTemplates)("%s", (template) => {
    it("ships AGENTS.md pointing at the docs MCP server", () => {
      expect(
        readFileSync(path.join(templatesDir, template, "AGENTS.md"), "utf8"),
      ).toContain("https://cdktn.io/docs/mcp");
    });
  });

  // sscaff overwrites unconditionally, so a shipped .mcp.json would replace the user's before init can check for it.
  it("no template ships an .mcp.json", () => {
    const shipped = readdirSync(templatesDir).flatMap((template) =>
      [".mcp.json", "{{}}.mcp.json"]
        .map((file) => path.join(template, file))
        .filter((file) => existsSync(path.join(templatesDir, file))),
    );
    expect(shipped).toEqual([]);
  });

  // The package-manager variants reuse the `typescript` files through template variables. A file duplicated into a
  // variant directory silently replaces the base's copy, and a literal npm command in the base leaks into every variant.
  describe("typescript-pnpm", () => {
    it("does not shadow any file of the base template", () => {
      const baseFiles = readdirSync(path.join(templatesDir, "typescript"));
      const shadowed = readdirSync(
        path.join(templatesDir, "typescript-pnpm"),
      ).filter((file) => baseFiles.includes(file));

      expect(shadowed).toEqual([]);
    });

    it.each(["AGENTS.md", "cdktf.json", "help", "package.json"])(
      "the base template's %s takes its package manager commands from variables",
      (file) => {
        const contents = readFileSync(
          path.join(templatesDir, "typescript", file),
          "utf8",
        );

        expect(contents).toMatch(/\{\{ pm(Run|Add|Exec) \}\}/);
        // The npmjs.com search URL is a registry link rather than a command, so it legitimately survives.
        expect(
          contents.replace(/https:\/\/www\.npmjs\.com\S*/g, ""),
        ).not.toMatch(/\b(npm (run|install|i) |npx )/);
      },
    );
  });
});
