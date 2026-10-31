/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import yargs from "yargs";
import { logger } from "@cdktn/commons";
import initCommand from "../init";
import { readPackageJson } from "../helper/utilities";

function parseInit(args: string[]) {
  return initCommand
    .builder(yargs([]).exitProcess(false))
    .parseSync(args) as Record<string, any>;
}

describe("init version options", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => logger);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("falls back to the CLI's own version", () => {
    const argv = parseInit([]);
    expect(argv.cdktnVersion).toBe(readPackageJson().version);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reads --cdktn-version without a deprecation warning", () => {
    const argv = parseInit(["--cdktn-version", "1.2.3"]);
    expect(argv.cdktnVersion).toBe("1.2.3");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("uses the deprecated --cdktf-version value and warns", () => {
    const argv = parseInit(["--cdktf-version", "1.2.3"]);
    expect(argv.cdktnVersion).toBe("1.2.3");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("--cdktf-version is deprecated"),
    );
  });

  it("prefers --cdktn-version when both are passed", () => {
    const argv = parseInit([
      "--cdktn-version",
      "2.0.0",
      "--cdktf-version",
      "1.2.3",
    ]);
    expect(argv.cdktnVersion).toBe("2.0.0");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("--cdktf-version is deprecated"),
    );
  });
});
