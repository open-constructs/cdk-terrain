// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as path from "path";
import { generateProviderBindingsFromSchema } from "..";
import { AttributeType, Block, mkdtemp } from "@cdktn/commons";
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

const block = (name: string, b: Block) =>
  new S().listBlock({ name, block: b, minItems: 0, maxItems: 9 }).asBlock();
// same_a/same_b and twin_a/twin_b each share a shape (twins all the way down);
// deep_a/deep_b match only at the first level.
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
        name: "twin_a",
        block: nested("bool"),
        minItems: 0,
        maxItems: 9,
      })
      .listBlock({
        name: "twin_b",
        block: nested("bool"),
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

// Pairs whose fields match by name, type and optionality but whose mappers
// differ. aws.security_group.ingress.* has entries in CUSTOM_DEFAULTS.
const objects: AttributeType = ["list", ["object", { description: "string" }]];
const lookalikes = schema({
  name: "aws",
  provider: new S().build(),
  dataSources: {},
  resources: {
    aws_security_group: new S()
      .attribute({ name: "ingress", type: objects })
      .attribute({ name: "tag", type: objects })
      .listBlock({
        name: "as_block",
        block: block("x", leaf("v", "string")),
        minItems: 0,
        maxItems: 9,
      })
      .listBlock({
        name: "as_attr",
        block: new S()
          .attribute({ name: "x", type: ["list", ["object", { v: "string" }]] })
          .asBlock(),
        minItems: 0,
        maxItems: 9,
      })
      .listBlock({
        name: "write_only",
        block: new S()
          .attribute({ name: "s", type: "string", writeOnly: true })
          .asBlock(),
        minItems: 0,
        maxItems: 9,
      })
      .listBlock({
        name: "plain",
        block: leaf("s", "string"),
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

async function generate(
  mode?: string,
  provider = fixture,
  providerName = "dedup",
): Promise<Exports> {
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
      await generateProviderBindingsFromSchema(dir, provider);
      const root = path.join(dir, "providers", providerName);
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

  it("full merges a shared shape at every level", () => {
    const twins = [
      "ShapesTwinA",
      "ShapesTwinB",
      "ShapesTwinAInner",
      "ShapesTwinBInner",
    ];
    expect(twins.filter((n) => off.interfaces.has(n))).toEqual(twins);
    expect(twins.filter((n) => full.interfaces.has(n))).toEqual([
      "ShapesTwinA",
      "ShapesTwinAInner",
    ]);
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

  describe("full keeps lookalike structs whose mappers differ", () => {
    let lookalikesFull: Exports;

    beforeAll(async () => {
      lookalikesFull = await generate("full", lookalikes, "aws");
    });

    it.each([
      ["a custom default", "SecurityGroupIngress", "SecurityGroupTag"],
      [
        "a block vs. an attribute",
        "SecurityGroupAsBlock",
        "SecurityGroupAsAttr",
      ],
      ["a write-only field", "SecurityGroupWriteOnly", "SecurityGroupPlain"],
    ])("%s", (_, a, b) => {
      expect([a, b].filter((n) => !lookalikesFull.interfaces.has(n))).toEqual(
        [],
      );
    });
  });

  it("rejects an unknown mode", async () => {
    await expect(generate("bogus")).rejects.toThrow(
      'Unknown CDKTN_STRUCT_DEDUP_MODE "bogus" (expected "full")',
    );
  });
});
