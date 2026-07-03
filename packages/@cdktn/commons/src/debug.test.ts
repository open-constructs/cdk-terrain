// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";

jest.mock("./terraform", () => ({
  terraformVersion: Promise.resolve("1.7.5"),
}));

import { collectDebugInformation } from "./debug";
import { withTempDir } from "./util";

function writeInstalledPackage(packageName: string, version: string) {
  const packageDir = path.join(process.cwd(), "node_modules", packageName);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version }, null, 2),
  );
}

describe("collectDebugInformation()", () => {
  let previousNodeEnv: string | undefined;

  beforeEach(() => {
    previousNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  it("detects TypeScript packages installed as npm dev dependencies in production", async () => {
    await withTempDir("debug.test", async () => {
      fs.writeFileSync(
        "cdktf.json",
        JSON.stringify({ language: "typescript" }),
      );
      fs.writeFileSync(
        "package.json",
        JSON.stringify(
          {
            name: "debug-dev-dependency-fixture",
            version: "1.0.0",
            devDependencies: {
              cdktn: "0.23.3",
              cdktf: "0.20.11",
              constructs: "10.3.0",
              jsii: "5.5.0",
            },
          },
          null,
          2,
        ),
      );

      writeInstalledPackage("cdktn", "0.23.3");
      writeInstalledPackage("cdktf", "0.20.11");
      writeInstalledPackage("constructs", "10.3.0");
      writeInstalledPackage("jsii", "5.5.0");

      process.env.NODE_ENV = "production";

      await expect(collectDebugInformation()).resolves.toEqual(
        expect.objectContaining({
          language: "typescript",
          cdktn: "0.23.3",
          cdktf: "0.20.11",
          constructs: "10.3.0",
          jsii: "5.5.0",
        }),
      );
    });
  });
});
