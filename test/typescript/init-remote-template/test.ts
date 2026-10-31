// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TestDriver } from "../../test-helper";
import { TemplateServer } from "../../template-server";
import * as path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs").promises;

describe("remote templates", () => {
  test("can init", async () => {
    const driver = new TestDriver(__dirname);
    await driver.setupRemoteTemplateProject();
    const files = await fs.readdir(driver.workingDirectory);
    expect(files).toEqual(
      expect.arrayContaining([
        ".gen",
        ".gitignore",
        ".npmrc",
        "cdktf.json",
        "help",
        "jest.config.js",
        "main.ts",
        "package.json",
        "setup.js",
        "tsconfig.json",
        "__tests__",
      ]),
    );
  });

  // A remote archive decides its own directory names; one that happens to match a built-in variant must still be
  // scaffolded from the archive, not from the CLI's templates.
  test("scaffolds the archive even when its directory is named like a built-in variant", async () => {
    const server = new TemplateServer(
      path.join(__dirname, "named-like-variant"),
    );
    try {
      const url = await server.start();
      const driver = new TestDriver(__dirname);
      driver.switchToTempDir();
      await driver.init(url);

      const files = await fs.readdir(driver.workingDirectory);
      expect(files).toContain("REMOTE_TEMPLATE");
      expect(files).not.toContain("pnpm-workspace.yaml");
      expect(files).not.toContain("main.ts");
    } finally {
      await server.stop();
    }
  });

  test("handles invalid url", async () => {
    const driver = new TestDriver(__dirname);

    try {
      await driver.setupRemoteTemplateProject("invalid_url");
      fail("Expected init to throw an error");
    } catch (e) {
      expect(e.stderr).toContain(
        "Could not download template: the supplied url is invalid",
      );
    }
  });
});
