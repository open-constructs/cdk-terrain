// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { logger } from "@cdktn/commons";
import { getConstructIdsForOutputs } from "../../lib/output";
import { TerraformOutput } from "../../lib/models/terraform";

function output(value: string): TerraformOutput {
  return { sensitive: false, type: "string", value };
}

function stackDeclaring(outputs: Record<string, Record<string, string>>) {
  return { "//": { outputs } };
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("getConstructIdsForOutputs", () => {
  it("keys every returned output by its construct id without warning", () => {
    const result = getConstructIdsForOutputs(
      "app",
      stackDeclaring({ network: { address: "network_address_1A2B" } }),
      { network_address_1A2B: output("::1") },
    );

    expect(result).toStrictEqual({ network: { address: output("::1") } });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("omits only the output terraform did not return and names it and its stack in a warning", () => {
    const result = getConstructIdsForOutputs(
      "app",
      stackDeclaring({
        network: { ipv6: "ipv6_address", ipv4: "ipv4_address" },
      }),
      { ipv6_address: output("::1") },
    );

    expect(result).toStrictEqual({ network: { ipv6: output("::1") } });
    expect(warnSpy.mock.calls).toEqual([
      [
        '1 output declared by stack "app" was not returned by terraform and is omitted: network/ipv4 (ipv4_address)',
      ],
    ]);
  });

  it("drops a group left without outputs and reports every omitted output in one warning", () => {
    const result = getConstructIdsForOutputs(
      "app",
      stackDeclaring({
        network: { a: "missing_a", b: "missing_b" },
        db: { host: "db_host", port: "missing_port" },
      }),
      { db_host: output("db.internal") },
    );

    expect(result).toStrictEqual({ db: { host: output("db.internal") } });
    expect(warnSpy.mock.calls).toEqual([
      [
        '3 outputs declared by stack "app" were not returned by terraform and are omitted: network/a (missing_a), network/b (missing_b), db/port (missing_port)',
      ],
    ]);
  });

  it("treats a null output like a missing one", () => {
    const result = getConstructIdsForOutputs(
      "app",
      stackDeclaring({
        network: { ipv6: "ipv6_address", ipv4: "ipv4_address" },
      }),
      { ipv6_address: output("::1"), ipv4_address: null } as any,
    );

    expect(result).toStrictEqual({ network: { ipv6: output("::1") } });
    expect(warnSpy.mock.calls).toEqual([
      [
        '1 output declared by stack "app" was not returned by terraform and is omitted: network/ipv4 (ipv4_address)',
      ],
    ]);
  });

  it("returns the outputs as they are when the stack carries no output metadata", () => {
    const outputs = { plain: output("value") };

    expect(getConstructIdsForOutputs("app", {}, outputs)).toBe(outputs);
  });
});
