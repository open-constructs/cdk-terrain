// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { DependencyManager } from "@cdktn/cli-core";

jest.mock("../helper/version-check", () => ({
  displayVersionMessage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("ci-info", () => ({ isCI: false, name: null }));

const mockGetLib = jest.fn();
jest.mock("@cdktn/cli-core", () => ({
  ...jest.requireActual("@cdktn/cli-core"),
  get: (...args: unknown[]) => mockGetLib(...args),
}));
jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  getPackageVersion: jest.fn().mockResolvedValue("0.23.0"),
}));

import { providerUpgrade } from "../handlers";

// The binding's terraformProviderSource is the source of the constraint
// generated here, so a host lost on the way would reach synth.
describe("provider upgrade of a local provider", () => {
  const originalCwd = process.cwd();
  let workdir: string;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-upgrade-"));
    process.chdir(workdir);
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest
      .spyOn(DependencyManager.prototype, "getCurrentlyInstalledVersion")
      .mockResolvedValue(undefined);
    mockGetLib.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockGetLib.mockReset();
    process.chdir(originalCwd);
    fs.removeSync(workdir);
  });

  it.each([
    ["a string entry", "registry.opentofu.org/hashicorp/random@=3.6.0"],
    [
      "an object entry",
      {
        name: "random",
        source: "registry.opentofu.org/hashicorp/random",
        version: "=3.6.0",
      },
    ],
  ])(
    "generates %s with the host it names after a shorthand upgrade",
    async (_name, entry) => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
        app: "npx ts-node main.ts",
        sendCrashReports: false,
        terraformProviders: [entry],
        targetVersions: { opentofu: ">=1.6.0" },
      });

      await providerUpgrade({ provider: ["random@=3.6.1"] });

      expect(mockGetLib).toHaveBeenCalledTimes(1);
      const [{ constraintsToGenerate }] = mockGetLib.mock.calls[0];
      expect(
        constraintsToGenerate.map((c: { source: string; version?: string }) => [
          c.source,
          c.version,
        ]),
      ).toEqual([["registry.opentofu.org/hashicorp/random", "=3.6.1"]]);
    },
  );
});
