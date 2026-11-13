// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as path from "path";
import { generateProviderBindingsFromSchema } from "..";
import { AttributeType, mkdtemp } from "@cdktn/commons";
import { schema, SchemaBuilder as S } from "./edge-provider-schema/builder";

const leaf = (name: string, type: AttributeType) =>
  new S().attribute({ name, type }).asBlock();
const nested = (type: AttributeType) =>
  new S()
    .listBlock({
      name: "inner",
      block: leaf("w", type),
      minItems: 0,
      maxItems: 9,
    })
    .asBlock();

// same_a/same_b share one shape; deep_a/deep_b match only at the first level.
const fixture = schema({
  name: "dedup",
  provider: new S().build(),
  dataSources: {},
  resources: {
    shapes: new S()
      .listBlock({
        name: "same_a",
        block: leaf("v", "string"),
        minItems: 0,
        maxItems: 9,
      })
      .listBlock({
        name: "same_b",
        block: leaf("v", "string"),
        minItems: 0,
        maxItems: 9,
      })
      .listBlock({
        name: "deep_a",
        block: nested("string"),
        minItems: 0,
        maxItems: 9,
      })
      .listBlock({
        name: "deep_b",
        block: nested("number"),
        minItems: 0,
        maxItems: 9,
      })
      .build(),
  },
});

interface Exports {
  interfaces: Map<string, string>;
  classes: Set<string>;
  functions: Set<string>;
}

async function generate(mode?: string): Promise<Exports> {
  const previous = process.env.CDKTN_STRUCT_DEDUP_MODE;
  if (mode === undefined) delete process.env.CDKTN_STRUCT_DEDUP_MODE;
  else process.env.CDKTN_STRUCT_DEDUP_MODE = mode;
  try {
    const exports: Exports = {
      interfaces: new Map(),
      classes: new Set(),
      functions: new Set(),
    };
    await mkdtemp(async (dir) => {
      await generateProviderBindingsFromSchema(dir, fixture);
      const root = path.join(dir, "providers", "dedup");
      for (const file of fs.readdirSync(root, {
        recursive: true,
        encoding: "utf8",
      })) {
        if (!file.endsWith(".ts")) continue;
        const source = fs.readFileSync(path.join(root, file), "utf8");
        for (const m of source.matchAll(
          /\nexport interface (\w+)[^{]*\{.*?\n\}/gs,
        )) {
          exports.interfaces.set(m[1], m[0]);
        }
        for (const m of source.matchAll(/\nexport class (\w+)/g)) {
          exports.classes.add(m[1]);
        }
        for (const m of source.matchAll(/\nexport function (\w+)/g)) {
          exports.functions.add(m[1]);
        }
      }
    });
    return exports;
  } finally {
    if (previous === undefined) delete process.env.CDKTN_STRUCT_DEDUP_MODE;
    else process.env.CDKTN_STRUCT_DEDUP_MODE = previous;
  }
}

describe("CDKTN_STRUCT_DEDUP_MODE", () => {
  let off: Exports;
  let full: Exports;

  beforeAll(async () => {
    off = await generate();
    full = await generate("full");
  });

  it("full merges structs of the same shape", () => {
    const same = ["ShapesSameA", "ShapesSameB"];
    expect(same.filter((n) => off.interfaces.has(n))).toEqual(same);
    expect(same.filter((n) => full.interfaces.has(n))).toHaveLength(1);
  });

  it("full keeps structs that differ only below the first level", () => {
    const deep = [
      "ShapesDeepA",
      "ShapesDeepB",
      "ShapesDeepAInner",
      "ShapesDeepBInner",
    ];
    expect(deep.filter((n) => !full.interfaces.has(n))).toEqual([]);
  });

  it("rejects an unknown mode", async () => {
    await expect(generate("bogus")).rejects.toThrow(
      'Unknown CDKTN_STRUCT_DEDUP_MODE "bogus" (expected "full")',
    );
  });
});
