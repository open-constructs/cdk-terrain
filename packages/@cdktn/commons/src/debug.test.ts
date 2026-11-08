// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";

jest.mock("./terraform", () => ({
  terraformVersion: jest.fn(() => Promise.resolve("1.7.5")),
}));

jest.mock("./util", () => {
  const actual = jest.requireActual("./util");
  return { ...actual, exec: jest.fn(actual.exec) };
});

import { collectDebugInformation, getPackageVersion } from "./debug";
import { terraformVersion } from "./terraform";
import { exec, withTempDir } from "./util";

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

  it("reports terraform as null when the binary cannot be probed", async () => {
    jest.mocked(terraformVersion).mockResolvedValueOnce(undefined);
    await withTempDir("debug.test", async () => {
      await expect(collectDebugInformation()).resolves.toEqual(
        expect.objectContaining({ terraform: null }),
      );
    });
  });
});

describe("getPackageVersion() for csharp", () => {
  const dotnetOutput = (topLevel: string[], transitive: string[]) =>
    [
      "Project 'app' has the following package references",
      "   [net8.0]:",
      "   Top-level Package      Requested   Resolved",
      ...topLevel.map((l) => `   > ${l}`),
      "",
      "   Transitive Package     Resolved",
      ...transitive.map((l) => `   > ${l}`),
    ].join("\n");

  it("returns the core cdktn version, not a colliding provider version", async () => {
    jest
      .mocked(exec)
      .mockResolvedValueOnce(
        dotnetOutput(
          ["Io.Cdktn.Providers.Aws       1.2.0   1.2.0"],
          ["Io.Cdktn                     0.22.0"],
        ),
      );

    await expect(getPackageVersion("csharp", "cdktn")).resolves.toBe("0.22.0");
  });

  it("returns the legacy cdktf version, not a colliding provider version", async () => {
    jest
      .mocked(exec)
      .mockResolvedValueOnce(
        dotnetOutput(
          ["HashiCorp.Cdktf.Providers.Aws   1.2.0   1.2.0"],
          ["HashiCorp.Cdktf                 0.20.11"],
        ),
      );

    await expect(getPackageVersion("csharp", "cdktf")).resolves.toBe("0.20.11");
  });

  it("matches package names case-insensitively", async () => {
    jest
      .mocked(exec)
      .mockResolvedValueOnce(
        dotnetOutput(["io.cdktn      0.22.0   0.22.0"], []),
      );

    await expect(getPackageVersion("csharp", "cdktn")).resolves.toBe("0.22.0");
  });

  it("returns undefined when only a provider package is present", async () => {
    jest
      .mocked(exec)
      .mockResolvedValueOnce(
        dotnetOutput(["Io.Cdktn.Providers.Aws   1.2.0   1.2.0"], []),
      );

    await expect(getPackageVersion("csharp", "cdktn")).resolves.toBeUndefined();
  });
});
