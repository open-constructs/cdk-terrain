// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

jest.mock("../provider-schema", () => ({
  ...jest.requireActual("../provider-schema"),
  readProviderSchema: jest.fn(),
  getFetchingCliVersion: jest.fn(),
}));

import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  logger,
  ProviderSchema,
  TerraformProviderConstraint,
} from "@cdktn/commons";
import { readSchema } from "../read";
import { getFetchingCliVersion, readProviderSchema } from "../provider-schema";

const readProviderSchemaMock = readProviderSchema as unknown as jest.Mock;
const getFetchingCliVersionMock = getFetchingCliVersion as unknown as jest.Mock;

const stampedFixture: ProviderSchema = {
  format_version: "0.1",
  cli_name: "terraform",
  cli_version: "1.7.5",
};

describe("readSchema - emission gap warning on cache hits (regression)", () => {
  let cacheDir: string;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-schema-cache-"));
    warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    getFetchingCliVersionMock.mockReset();
    getFetchingCliVersionMock.mockResolvedValue({
      name: "terraform",
      version: "1.7.5",
    });
    readProviderSchemaMock.mockReset();
    readProviderSchemaMock.mockResolvedValue(stampedFixture);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    fs.removeSync(cacheDir);
  });

  it("fires the warning on both a fresh fetch and a later cache hit for the same target", async () => {
    const constraint = new TerraformProviderConstraint("hashicorp/null@3.1.0");
    const targetVersions = { terraform: ">=1.12.0" };

    await readSchema([constraint], cacheDir, targetVersions);
    await readSchema([constraint], cacheDir, targetVersions);

    // second readSchema call is served from the on-disk cache written by the
    // first - the underlying fetch only ever runs once.
    expect(readProviderSchemaMock).toHaveBeenCalledTimes(1);

    // yet the emission-gap warning fires for both calls, because it now
    // runs against the resolved (cached-or-fresh) schema in read.ts, not
    // inside readProviderSchema.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0][0]).toContain(
      "provider schema fetched with terraform 1.7.5",
    );
    expect(warnSpy.mock.calls[1][0]).toContain(
      "provider schema fetched with terraform 1.7.5",
    );
  });
});
