// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  getConstructIdsForOutputs,
  saveOutputs,
  NestedTerraformOutputs,
} from "../../lib/output";
import { TerraformOutput } from "../../lib/models/terraform";
import { logger } from "@cdktn/commons";
import * as fs from "fs";

function output(value: string, sensitive = false): TerraformOutput {
  return { sensitive, type: "string", value };
}

describe("getConstructIdsForOutputs", () => {
  it("maps a metadata-declared output that is present in terraform output", () => {
    const stackContent = {
      "//": {
        outputs: {
          myStack: {
            myOutput: "cross-stack-output-myOutput",
          },
        },
      },
    };
    const outputs = {
      "cross-stack-output-myOutput": output("hello"),
    };

    const result = getConstructIdsForOutputs(stackContent, outputs);
    expect(result).toEqual({
      myStack: { myOutput: output("hello") },
    });
  });

  it("omits only the missing key on a partial miss within one stack (the regression case)", () => {
    const stackContent = {
      "//": {
        outputs: {
          network: {
            ipv6_app_address: "ipv6_app_address",
            public_ipv4_address: "public_ipv4_address",
            "cross-stack-output-db-host": "cross-stack-output-db-host",
          },
        },
      },
    };
    // Only some of the declared outputs come back from `terraform output -json`.
    const outputs = {
      ipv6_app_address: output("::1"),
      "cross-stack-output-db-host": output("db.internal"),
      // public_ipv4_address is absent -> partial miss
    };

    const result = getConstructIdsForOutputs(stackContent, outputs) as any;

    expect(result.network).not.toHaveProperty("public_ipv4_address");
    expect(result.network.public_ipv4_address).toBeUndefined();
    expect(result.network.ipv6_app_address).toEqual(output("::1"));
    expect(result.network["cross-stack-output-db-host"]).toEqual(
      output("db.internal"),
    );
  });

  it("drops an entire group when every declared output in it is absent (isObjectEmpty path)", () => {
    const stackContent = {
      "//": {
        outputs: {
          network: {
            a: "missing-a",
            b: "missing-b",
          },
        },
      },
    };
    const outputs = {};

    const result = getConstructIdsForOutputs(stackContent, outputs);
    // NOTE: this assertion alone does not discriminate the omission logic - a group whose every
    // declared output is missing ends up empty either way (isObjectEmpty() considers it so) whether
    // or not the missing keys are individually omitted, and the whole group is dropped regardless.
    // The test that does discriminate it is the partial-miss case above ("omits only the missing key
    // on a partial miss..."), where a mix of present and absent outputs means the group is NOT empty
    // and an unguarded lookup would retain the missing key with an `undefined` value instead of
    // omitting it.
    expect(result).toEqual({});
    expect(result).not.toHaveProperty("network");
  });

  it("warns when a user-declared output is absent from terraform output", () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const debugSpy = jest.spyOn(logger, "debug").mockImplementation(() => {});

    const stackContent = {
      "//": {
        outputs: {
          network: {
            public_ipv4_address: "public_ipv4_address",
          },
        },
      },
    };
    const outputs = {};

    getConstructIdsForOutputs(stackContent, outputs);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("public_ipv4_address");
    expect(debugSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("only debug-logs (does not warn) when a missing output is generated cross-stack plumbing", () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const debugSpy = jest.spyOn(logger, "debug").mockImplementation(() => {});

    const stackContent = {
      "//": {
        outputs: {
          network: {
            "cross-stack-output-db-host": "cross-stack-output-db-host",
          },
        },
      },
    };
    const outputs = {};

    getConstructIdsForOutputs(stackContent, outputs);

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0][0]).toContain("cross-stack-output-db-host");
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("passes outputs through unchanged when there is no metadata (older cdktf versions)", () => {
    const stackContent = {};
    const outputs = {
      plain: output("value"),
    };

    const result = getConstructIdsForOutputs(stackContent, outputs);
    expect(result).toBe(outputs);
  });
});

describe("saveOutputs / unpackTerraformOutput with a partial miss", () => {
  it("writes only the resolved outputs to disk, without an 'undefined' entry", async () => {
    const nested: NestedTerraformOutputs = {
      network: {
        ipv6_app_address: output("::1"),
        // public_ipv4_address was already omitted upstream by getConstructIdsForOutputs
      },
    };

    const writeFileSpy = jest
      .spyOn(fs, "writeFileSync")
      .mockImplementation(() => undefined);

    await saveOutputs("/tmp/outputs.json", nested, false);

    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(written).toEqual({ network: { ipv6_app_address: "::1" } });
    expect(JSON.stringify(written)).not.toContain("undefined");

    writeFileSpy.mockRestore();
  });

  it("does not throw when a stack group mixes an undefined leaf and a null leaf", async () => {
    // Both shapes can reach unpackTerraformOutput's Object.entries() recursion unguarded: `undefined`
    // is the shape left behind when a caller bypasses getConstructIdsForOutputs (which omits
    // unresolved outputs rather than keeping them as `undefined`), and `null` reaches the
    // object-recursion branch here because isTerraformOutput(null) returns false, routing it past the
    // leaf check instead of throwing earlier. Neither is a valid TerraformOutput nor a valid nested
    // group.
    const nested: NestedTerraformOutputs = {
      s: {
        a: output("hello"),
        b: undefined,
        c: null,
      } as any,
    };

    const writeFileSpy = jest
      .spyOn(fs, "writeFileSync")
      .mockImplementation(() => undefined);

    await expect(
      saveOutputs("/tmp/outputs.json", nested, false),
    ).resolves.toBeUndefined();

    const written = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(written).toEqual({ s: { a: "hello" } });
    expect(written.s).not.toHaveProperty("b");
    expect(written.s).not.toHaveProperty("c");

    writeFileSpy.mockRestore();
  });
});
