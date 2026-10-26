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

  // Every scaffolded project points coding agents at the docs MCP server. The config is a dotfile, which npm can drop
  // from the published tarball, so it ships under the `{{}}` prefix that sscaff strips (like `{{}}.gitignore`).
  describe.each(baseTemplates)("%s", (template) => {
    it("ships AGENTS.md and an MCP config for the docs server", () => {
      const dir = path.join(templatesDir, template);
      const mcp = JSON.parse(
        readFileSync(path.join(dir, "{{}}.mcp.json"), "utf8"),
      );

      expect(mcp.mcpServers.cdktn).toEqual({
        type: "http",
        url: "https://cdktn.io/docs/mcp",
      });
      expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toContain(
        "https://cdktn.io/docs/mcp",
      );
    });
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
