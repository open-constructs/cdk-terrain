// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as path from "path";
import * as ts from "typescript";
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
// same_a/same_b, one_a/one_b and twin_a/twin_b each share a shape (lists and
// single items take different input paths; twins match all the way down);
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
        name: "one_a",
        block: leaf("u", "string"),
        minItems: 0,
        maxItems: 1,
      })
      .listBlock({
        name: "one_b",
        block: leaf("u", "string"),
        minItems: 0,
        maxItems: 1,
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

// The same object under list(list(...)) and list(set(...)). The wrapper chain
// reaches the signature through the inner struct's nestingMode.
const wrapped = (inner: "list" | "set") =>
  new S()
    .attribute({
      name: "x",
      type: ["list", [inner, ["object", { v: "string" }]]],
    })
    .asBlock();
const wrappers = schema({
  name: "dedup",
  provider: new S().build(),
  dataSources: {},
  resources: {
    wrappers: new S()
      .listBlock({
        name: "lists",
        block: wrapped("list"),
        minItems: 0,
        maxItems: 9,
      })
      .listBlock({
        name: "sets",
        block: wrapped("set"),
        minItems: 0,
        maxItems: 9,
      })
      .build(),
  },
});

// Enough structs that the resource's structs are sharded into their own files
// (and imported back) even after same_a/same_b merge.
const wideBlocks = new S();
for (let i = 0; i < 100; i++) {
  wideBlocks.listBlock({
    name: `b${i}`,
    block: leaf(`v${i}`, "string"),
    minItems: 0,
    maxItems: 9,
  });
}
const wide = schema({
  name: "dedup",
  provider: new S().build(),
  dataSources: {},
  resources: {
    wide: wideBlocks
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
      .build(),
  },
});

// One shape copied enough times that, once compat makes the copies
// interface-only, the last shard holds nothing but plain interfaces.
const copies = new S();
for (let i = 0; i <= 500; i++) {
  copies.listBlock({
    name: `dup_${String(i).padStart(3, "0")}`,
    block: leaf("v", "string"),
    minItems: 0,
    maxItems: 9,
  });
}
const copied = schema({
  name: "dedup",
  provider: new S().build(),
  dataSources: {},
  resources: { copied: copies.build() },
});

interface Exports {
  files: Map<string, string>;
  interfaces: Map<string, string>;
  classes: Set<string>;
  functions: Set<string>;
}

async function withBindings<T>(
  mode: string | undefined,
  provider: typeof fixture,
  providerName: string,
  inspect: (root: string) => T,
): Promise<T> {
  const previous = process.env.CDKTN_STRUCT_DEDUP_MODE;
  if (mode === undefined) delete process.env.CDKTN_STRUCT_DEDUP_MODE;
  else process.env.CDKTN_STRUCT_DEDUP_MODE = mode;
  try {
    let result!: T;
    await mkdtemp(async (dir) => {
      await generateProviderBindingsFromSchema(dir, provider);
      result = inspect(path.join(dir, "providers", providerName));
    });
    return result;
  } finally {
    if (previous === undefined) delete process.env.CDKTN_STRUCT_DEDUP_MODE;
    else process.env.CDKTN_STRUCT_DEDUP_MODE = previous;
  }
}

function generate(
  mode?: string,
  provider = fixture,
  providerName = "dedup",
): Promise<Exports> {
  return withBindings(mode, provider, providerName, (root) => {
    const exports: Exports = {
      files: new Map(),
      interfaces: new Map(),
      classes: new Set(),
      functions: new Set(),
    };
    for (const file of fs.readdirSync(root, {
      recursive: true,
      encoding: "utf8",
    })) {
      if (!file.endsWith(".ts")) continue;
      const source = fs.readFileSync(path.join(root, file), "utf8");
      exports.files.set(file.split(path.sep).join("/"), source);
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
    return exports;
  });
}

// Type-checks generated bindings the way jsii compiles them (strict, no unused locals).
function typeErrors(
  mode: string,
  provider: typeof fixture,
  providerName: string,
): Promise<string[]> {
  const cdktn = path.dirname(require.resolve("cdktn/package.json"));
  const constructs = path.dirname(
    require.resolve("constructs/package.json", { paths: [cdktn] }),
  );
  return withBindings(mode, provider, providerName, (root) => {
    const files = fs
      .readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join(root, f));
    const program = ts.createProgram(files, {
      noEmit: true,
      strict: true,
      noUnusedLocals: true,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: [
        path.dirname(path.dirname(require.resolve("@types/node/package.json"))),
      ],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      paths: {
        cdktn: [path.join(cdktn, "lib/index.d.ts")],
        constructs: [path.join(constructs, "lib/index.d.ts")],
      },
    });
    return ts
      .getPreEmitDiagnostics(program)
      .map((d) =>
        ts.flattenDiagnosticMessageText(d.messageText, "\n").slice(0, 200),
      );
  });
}

describe("CDKTN_STRUCT_DEDUP_MODE", () => {
  let off: Exports;
  let full: Exports;
  let compat: Exports;

  beforeAll(async () => {
    off = await generate();
    full = await generate("full");
    compat = await generate("compat");
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

  it("compat leaves every interface declaration unchanged", () => {
    expect(compat.interfaces).toEqual(off.interfaces);
  });

  it("compat emits only the classes and mappers full keeps", () => {
    expect(compat.classes).toEqual(full.classes);
    expect(compat.functions).toEqual(full.functions);
    expect(compat.classes.size).toBeLessThan(off.classes.size);
  });

  it.each(["full", "compat"])(
    "%s imports a struct shared by top-level attributes once",
    async (mode) => {
      const { files } = await generate(mode, wide);
      expect(files.has("wide/index-structs/index.ts")).toBe(true);
      const names = files
        .get("wide/index.ts")!
        .match(/import \{([^}]*)\} from '\.\/index-structs/)![1]
        .split(",")
        .map((n) => n.trim());
      expect(names).toContain("WideSameA");
      expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    },
  );

  it("compat imports cdktn only into shards that use it", async () => {
    const { files } = await generate("compat", copied);
    const shards = [...files].filter(([f]) =>
      /^copied\/index-structs\/structs\d+\.ts$/.test(f),
    );
    expect(shards.length).toBeGreaterThan(1);
    const unused = shards
      .filter(([, src]) => src.includes("import * as cdktn"))
      .filter(
        ([, src]) => !src.replace("import * as cdktn", "").includes("cdktn."),
      )
      .map(([f]) => f);
    expect(unused).toEqual([]);
  });

  it("full keeps structs that differ only in an inner collection wrapper", async () => {
    const { interfaces } = await generate("full", wrappers);
    const kept = [
      "WrappersLists",
      "WrappersSets",
      "WrappersListsX",
      "WrappersSetsX",
    ];
    expect(kept.filter((n) => !interfaces.has(n))).toEqual([]);
  });

  it.each([
    ["full", "fixture", fixture, "dedup"],
    ["full", "lookalikes", lookalikes, "aws"],
    ["full", "wide", wide, "dedup"],
    ["compat", "fixture", fixture, "dedup"],
    ["compat", "lookalikes", lookalikes, "aws"],
    ["compat", "wide", wide, "dedup"],
    ["compat", "copied", copied, "dedup"],
  ] as const)(
    "%s output for %s type-checks",
    async (mode, _, provider, name) => {
      expect(await typeErrors(mode, provider, name)).toEqual([]);
    },
  );

  it("rejects an unknown mode", async () => {
    await expect(generate("bogus")).rejects.toThrow(
      'Unknown CDKTN_STRUCT_DEDUP_MODE "bogus" (expected "full" or "compat")',
    );
  });
});
