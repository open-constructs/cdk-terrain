// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logger } from "@cdktn/commons";
import { CdktfConfig } from "../../lib/cdktf-config";

describe("CdktfConfig.targetVersions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktf-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function writeConfig(targetVersions: unknown): string {
    const cdktfConfigPath = path.join(tmpDir, "cdktf.json");
    fs.writeFileSync(
      cdktfConfigPath,
      JSON.stringify({ language: "typescript", app: "", targetVersions }),
    );
    return cdktfConfigPath;
  }

  it("returns a well-formed targetVersions unchanged", () => {
    const cdktfConfigPath = writeConfig({ terraform: ">=1.5.7" });
    const config = new CdktfConfig(cdktfConfigPath);

    expect(config.targetVersions).toEqual({ terraform: ">=1.5.7" });
  });

  it("warns and returns undefined for a malformed targetVersions instead of throwing", () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const cdktfConfigPath = writeConfig({ terraform: "not-a-range" });
    const config = new CdktfConfig(cdktfConfigPath);

    expect(() => config.targetVersions).not.toThrow();
    expect(config.targetVersions).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("not-a-range"),
    );
  });

  it("returns undefined when targetVersions is not declared", () => {
    const cdktfConfigPath = writeConfig(undefined);
    const config = new CdktfConfig(cdktfConfigPath);

    expect(config.targetVersions).toBeUndefined();
  });
});
