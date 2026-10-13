// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logger } from "@cdktn/commons";
import { getConstructIdsForOutputs, saveOutputs } from "../../lib/output";
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
      stackDeclaring({ network: { address: "network_address_1A2B" } }),
      { network_address_1A2B: output("::1") },
    );

    expect(result).toStrictEqual({ network: { address: output("::1") } });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("omits only the output terraform did not return and names it in a warning", () => {
    const result = getConstructIdsForOutputs(
      stackDeclaring({
        network: { ipv6: "ipv6_address", ipv4: "ipv4_address" },
      }),
      { ipv6_address: output("::1") },
    );

    expect(result).toStrictEqual({ network: { ipv6: output("::1") } });
    expect(warnSpy.mock.calls).toEqual([
      [
        "1 output declared by the stack was not returned by terraform and is omitted: ipv4_address",
      ],
    ]);
  });

  it("drops a group left without outputs and reports every omitted output in one warning", () => {
    const result = getConstructIdsForOutputs(
      stackDeclaring({
        network: { a: "missing_a", b: "missing_b" },
        db: { host: "db_host", port: "missing_port" },
      }),
      { db_host: output("db.internal") },
    );

    expect(result).toStrictEqual({ db: { host: output("db.internal") } });
    expect(warnSpy.mock.calls).toEqual([
      [
        "3 outputs declared by the stack were not returned by terraform and are omitted: missing_a, missing_b, missing_port",
      ],
    ]);
  });

  it("treats a null output like a missing one", () => {
    const result = getConstructIdsForOutputs(
      stackDeclaring({
        network: { ipv6: "ipv6_address", ipv4: "ipv4_address" },
      }),
      { ipv6_address: output("::1"), ipv4_address: null } as any,
    );

    expect(result).toStrictEqual({ network: { ipv6: output("::1") } });
    expect(warnSpy.mock.calls[0][0]).toContain("ipv4_address");
  });

  it("returns the outputs as they are when the stack carries no output metadata", () => {
    const outputs = { plain: output("value") };

    expect(getConstructIdsForOutputs({}, outputs)).toBe(outputs);
  });
});

describe("saveOutputs", () => {
  it("writes the outputs that remain after a declared output went missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-outputs-"));
    const file = path.join(dir, "outputs.json");
    try {
      const outputs = getConstructIdsForOutputs(
        stackDeclaring({
          network: { ipv6: "ipv6_address", ipv4: "ipv4_address" },
        }),
        { ipv6_address: output("::1") },
      );

      await saveOutputs(file, outputs, false);

      expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({
        network: { ipv6: "::1" },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
