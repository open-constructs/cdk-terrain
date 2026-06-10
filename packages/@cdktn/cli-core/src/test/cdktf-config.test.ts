// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { CdktfConfig } from "../lib/cdktf-config";

describe("CdktfConfig.sendUsageTelemetry (validated typed getter, FR-005)", () => {
  let workdir: string;

  const writeConfig = (config: Record<string, unknown>) => {
    const file = path.join(workdir, "cdktf.json");
    fs.writeJsonSync(file, { language: "typescript", app: "true", ...config });
    return new CdktfConfig(file);
  };

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-config-"));
  });

  afterEach(() => {
    fs.removeSync(workdir);
  });

  it.each([
    [{ sendUsageTelemetry: true }, true],
    [{ sendUsageTelemetry: false }, false],
    // init templates render booleans as the strings "true"/"false"
    [{ sendUsageTelemetry: "true" }, true],
    [{ sendUsageTelemetry: "false" }, false],
  ])("reads %j as %p", (config, expected) => {
    expect(writeConfig(config).sendUsageTelemetry).toBe(expected);
  });

  it("returns undefined (never a default) when the flag is unset", () => {
    expect(writeConfig({}).sendUsageTelemetry).toBeUndefined();
  });

  it("throws External on a malformed value instead of coercing", () => {
    expect(
      () => writeConfig({ sendUsageTelemetry: "yes" }).sendUsageTelemetry,
    ).toThrow(
      'External Error: cdktf.json `sendUsageTelemetry` must be a boolean if set, got: "yes"',
    );
  });
});
