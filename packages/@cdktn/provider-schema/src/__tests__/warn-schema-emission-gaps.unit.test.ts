// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  exec: jest.fn(),
}));

import {
  DEFAULT_TARGET_VERSIONS,
  exec,
  logger,
  ProviderSchema,
} from "@cdktn/commons";
import { warnIfSchemaEmissionGaps } from "../provider-schema";

const execMock = exec as unknown as jest.Mock;

function stampedSchema(
  cli_name?: string,
  cli_version?: string,
): ProviderSchema {
  const schema: ProviderSchema = { format_version: "0.1" };
  if (cli_name) schema.cli_name = cli_name;
  if (cli_version) schema.cli_version = cli_version;
  return schema;
}

describe("warnIfSchemaEmissionGaps", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns once when the schema was stamped with an old CLI and default targets are declared", async () => {
    const schema = stampedSchema("terraform", "1.7.5");

    await warnIfSchemaEmissionGaps(schema, DEFAULT_TARGET_VERSIONS);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0];
    expect(message).toContain("provider schema fetched with terraform 1.7.5");
    expect(message).toContain("terraform >=1.12.0 / opentofu >=1.12.0");
  });

  it("stays silent when the schema was stamped with a recent CLI", async () => {
    const schema = stampedSchema("terraform", "1.15.6");

    await warnIfSchemaEmissionGaps(schema, DEFAULT_TARGET_VERSIONS);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("stays silent without declared targetVersions, even for an old stamped CLI", async () => {
    const schema = stampedSchema("terraform", "1.7.5");

    await warnIfSchemaEmissionGaps(schema, undefined);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to the current process's fetching CLI version when the schema carries no stamps", async () => {
    execMock.mockReset();
    execMock.mockResolvedValue("Terraform v1.7.5\non linux_amd64\n");

    const schema = stampedSchema();

    await warnIfSchemaEmissionGaps(schema, DEFAULT_TARGET_VERSIONS);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(
      "provider schema fetched with terraform 1.7.5",
    );
  });
});
