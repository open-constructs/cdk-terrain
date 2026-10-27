// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  Testing,
  TerraformStack,
  TerraformOutput,
  TerraformVariable,
  Fn,
  TypeExpr,
} from "../src";
import { toBeValidTerraform } from "../src/testing/matchers";
import { testIfConvertSupported } from "./helper/capabilities";

/** Synthesizes `convert(var.input, <type>)` and returns the output's value. */
function renderConvert(targetType: TypeExpr): string {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");
  const input = new TerraformVariable(stack, "input", {});
  new TerraformOutput(stack, "out", {
    value: Fn.convert(input.value, targetType),
  });
  return JSON.parse(Testing.synth(stack)).output.out.value;
}

/** Synthesizes the type expression as a variable `type` and returns it. */
function renderVariableType(targetType: TypeExpr): string {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");
  new TerraformVariable(stack, "input", { type: targetType.toString() });
  return JSON.parse(Testing.synth(stack)).variable.input.type;
}

/**
 * Runs `init` + `validate` with the matchers' CLI (TERRAFORM_BINARY_NAME) and
 * fails with the CLI's output if the synthesized stack is not valid.
 */
function expectValidForCli(stackDir: string) {
  const { pass, message } = toBeValidTerraform(stackDir);
  expect({ pass, message }).toMatchObject({ pass: true });
}

/** An object type whose string defaults need every kind of escaping. */
function trickyItem(): TypeExpr {
  const tricky = 'say "hi" \\ C:\\dir\\ ${x} %{if}';
  return TypeExpr.object({
    a: TypeExpr.optional(TypeExpr.STRING, tricky),
    m: TypeExpr.optional(TypeExpr.map(TypeExpr.STRING), {
      k: tricky,
      [tricky]: "v",
    }),
  });
}

describe("TypeExpr rendering", () => {
  test.each([
    ["STRING", TypeExpr.STRING, "string"],
    ["NUMBER", TypeExpr.NUMBER, "number"],
    ["BOOL", TypeExpr.BOOL, "bool"],
    ["ANY", TypeExpr.ANY, "any"],
    ["list", TypeExpr.list(TypeExpr.STRING), "list(string)"],
    ["set", TypeExpr.set(TypeExpr.NUMBER), "set(number)"],
    ["map", TypeExpr.map(TypeExpr.BOOL), "map(bool)"],
    [
      "tuple",
      TypeExpr.tuple([TypeExpr.STRING, TypeExpr.NUMBER, TypeExpr.ANY]),
      "tuple([string, number, any])",
    ],
    [
      "object",
      TypeExpr.object({ a: TypeExpr.STRING, "b-c": TypeExpr.NUMBER }),
      "object({a = string, b-c = number})",
    ],
    [
      "optional without default",
      TypeExpr.object({ a: TypeExpr.optional(TypeExpr.STRING) }),
      "object({a = optional(string)})",
    ],
    [
      "optional with literal defaults",
      TypeExpr.object({
        n: TypeExpr.optional(TypeExpr.NUMBER, 1),
        b: TypeExpr.optional(TypeExpr.BOOL, false),
        s: TypeExpr.optional(TypeExpr.STRING, "x"),
        l: TypeExpr.optional(TypeExpr.list(TypeExpr.STRING), ["a", "b"]),
        m: TypeExpr.optional(TypeExpr.map(TypeExpr.STRING), {}),
      }),
      'object({n = optional(number, 1), b = optional(bool, false), s = optional(string, "x"), l = optional(list(string), ["a", "b"]), m = optional(map(string), {})})',
    ],
    [
      "nested optional defaults",
      TypeExpr.list(
        TypeExpr.object({
          a: TypeExpr.STRING,
          inner: TypeExpr.optional(
            TypeExpr.object({
              x: TypeExpr.optional(TypeExpr.NUMBER, 2),
              tags: TypeExpr.optional(TypeExpr.map(TypeExpr.STRING), {
                env: "dev",
              }),
            }),
            {},
          ),
        }),
      ),
      'list(object({a = string, inner = optional(object({x = optional(number, 2), tags = optional(map(string), {"env" = "dev"})}), {})}))',
    ],
    ["empty object", TypeExpr.object({}), "object({})"],
    ["empty tuple", TypeExpr.tuple([]), "tuple([])"],
    [
      "optional with a null default",
      TypeExpr.object({ a: TypeExpr.optional(TypeExpr.STRING, null) }),
      "object({a = optional(string, null)})",
    ],
    [
      "fromString",
      TypeExpr.fromString("map(list(number))"),
      "map(list(number))",
    ],
  ])("%s inside Fn.convert", (_name, targetType, expected) => {
    expect(renderConvert(targetType)).toBe(
      `\${convert(var.input, ${expected})}`,
    );
  });

  test("escapes string defaults containing ${", () => {
    expect(
      renderConvert(
        TypeExpr.object({
          c: TypeExpr.optional(TypeExpr.STRING, "d${x}"),
        }),
      ),
    ).toBe('${convert(var.input, object({c = optional(string, "d$${x}")}))}');
  });

  test.each([
    ["double quotes", 'say "hi"', '"say \\"hi\\""'],
    ["backslashes", "C:\\dir\\", '"C:\\\\dir\\\\"'],
    ["interpolation sequences", "d${x}", '"d$${x}"'],
    ["template directives", "%{if}", '"%%{if}"'],
    ["a leading and trailing quote", '"q"', '"\\"q\\""'],
  ])("escapes %s in string defaults", (_name, defaultValue, expected) => {
    expect(
      renderConvert(
        TypeExpr.object({
          c: TypeExpr.optional(TypeExpr.STRING, defaultValue),
        }),
      ),
    ).toBe(
      `\${convert(var.input, object({c = optional(string, ${expected})}))}`,
    );
  });

  test("escapes strings nested in list and map defaults", () => {
    expect(
      renderConvert(
        TypeExpr.object({
          l: TypeExpr.optional(TypeExpr.list(TypeExpr.STRING), ['a"b']),
          m: TypeExpr.optional(TypeExpr.map(TypeExpr.STRING), { k: "\\" }),
        }),
      ),
    ).toBe(
      '${convert(var.input, object({l = optional(list(string), ["a\\"b"]), m = optional(map(string), {"k" = "\\\\"})}))}',
    );
  });

  test.each([
    ["double quotes", { 'a"b': "v" }, '{"a\\"b" = "v"}'],
    ["interpolation sequences", { "${k}": "v" }, '{"$${k}" = "v"}'],
    ["backslashes", { "a\\b": "v" }, '{"a\\\\b" = "v"}'],
  ])("escapes %s in map default keys", (_name, defaultValue, expected) => {
    expect(
      renderConvert(
        TypeExpr.object({
          m: TypeExpr.optional(TypeExpr.map(TypeExpr.STRING), defaultValue),
        }),
      ),
    ).toBe(
      `\${convert(var.input, object({m = optional(map(string), ${expected})}))}`,
    );
  });

  test("does not escape references in defaults", () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, "test");
    const fallback = new TerraformVariable(stack, "fallback", {});
    const input = new TerraformVariable(stack, "input", {});
    new TerraformOutput(stack, "out", {
      value: Fn.convert(
        input.value,
        TypeExpr.object({
          c: TypeExpr.optional(TypeExpr.STRING, fallback.stringValue),
        }),
      ),
    });
    expect(JSON.parse(Testing.synth(stack)).output.out.value).toBe(
      "${convert(var.input, object({c = optional(string, var.fallback)}))}",
    );
  });

  // optional() defaults in variable types work on every supported CLI
  // (Terraform >= 1.3, OpenTofu >= 1.6), so this runs against any binary.
  test("string defaults with quotes, backslashes and ${ are valid in a variable type", () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, "test");
    new TerraformVariable(stack, "cfg", {
      type: trickyItem().toString(),
      default: {},
    });

    expectValidForCli(Testing.fullSynth(stack));
  });

  testIfConvertSupported(
    "string defaults with quotes, backslashes and ${ are valid inside Fn.convert",
    () => {
      const app = Testing.app({
        context: {
          targetVersions: { terraform: ">=1.15.0", opentofu: ">=1.13.0" },
        },
      });
      const stack = new TerraformStack(app, "test");
      new TerraformOutput(stack, "out", {
        value: Fn.convert({}, trickyItem()),
      });

      expectValidForCli(Testing.fullSynth(stack));
    },
  );

  test("renders unquoted and without ${} as a variable type", () => {
    expect(
      renderVariableType(
        TypeExpr.object({
          a: TypeExpr.STRING,
          b: TypeExpr.optional(TypeExpr.NUMBER, 1),
        }),
      ),
    ).toBe("object({a = string, b = optional(number, 1)})");
  });

  test("rejects an optional() outside of object()", () => {
    expect(() =>
      renderVariableType(TypeExpr.optional(TypeExpr.STRING)),
    ).toThrow("TypeExpr.optional() is only valid inside TypeExpr.object()");
  });

  test.each([
    ["list", () => TypeExpr.list(TypeExpr.optional(TypeExpr.STRING))],
    ["set", () => TypeExpr.set(TypeExpr.optional(TypeExpr.STRING))],
    ["map", () => TypeExpr.map(TypeExpr.optional(TypeExpr.STRING))],
    [
      "tuple",
      () =>
        TypeExpr.tuple([TypeExpr.STRING, TypeExpr.optional(TypeExpr.STRING)]),
    ],
  ])("rejects an optional() element in %s()", (ctor, build) => {
    expect(build).toThrow(
      `TypeExpr.${ctor}(): TypeExpr.optional() is only valid as an attribute type inside TypeExpr.object()`,
    );
  });

  test("rejects an optional() wrapping another optional()", () => {
    expect(() => TypeExpr.optional(TypeExpr.optional(TypeExpr.STRING))).toThrow(
      "TypeExpr.optional() cannot wrap another optional()",
    );
  });
});

describe("TypeExpr.object attribute names", () => {
  test.each(["a", "_a", "a1", "a_b", "a-b", "A"])("accepts %s", (name) => {
    expect(
      renderVariableType(TypeExpr.object({ [name]: TypeExpr.STRING })),
    ).toBe(`object({${name} = string})`);
  });

  test.each(["", "1a", "-a", "a b", "a.b", 'a"', "a=b", "${a}"])(
    "rejects %p",
    (name) => {
      expect(() => TypeExpr.object({ [name]: TypeExpr.STRING })).toThrow(
        `TypeExpr.object(): "${name}" is not a valid attribute name`,
      );
    },
  );
});

describe("Fn.convert", () => {
  test("renders inside another function call", () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, "test");
    const items = new TerraformVariable(stack, "items", {});
    new TerraformOutput(stack, "nested", {
      value: Fn.lengthOf(
        Fn.convert(items.value, TypeExpr.set(TypeExpr.STRING)),
      ),
    });
    expect(JSON.parse(Testing.synth(stack)).output.nested.value).toBe(
      "${length(convert(var.items, set(string)))}",
    );
  });

  test("renders a literal value argument", () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, "test");
    new TerraformOutput(stack, "literal", {
      value: Fn.convert(
        ["a", 1],
        TypeExpr.tuple([TypeExpr.STRING, TypeExpr.STRING]),
      ),
    });
    expect(JSON.parse(Testing.synth(stack)).output.literal.value).toBe(
      '${convert(["a", 1], tuple([string, string]))}',
    );
  });

  test("rejects a type that is not a TypeExpr", () => {
    expect(() => Fn.convert("1", "number" as any)).toThrow(
      "Fn.convert(): type must be a TypeExpr, e.g. TypeExpr.list(TypeExpr.STRING)",
    );
    expect(() => Fn.convert("1", undefined as any)).toThrow(
      "Fn.convert(): type must be a TypeExpr",
    );
  });

  test("rejects a top-level optional() type", () => {
    expect(() => Fn.convert("1", TypeExpr.optional(TypeExpr.STRING))).toThrow(
      "Fn.convert(): TypeExpr.optional() is only valid as an attribute type inside TypeExpr.object()",
    );
  });
});

describe("TypeExpr.isTypeExpr", () => {
  test.each([
    ["a TypeExpr", TypeExpr.list(TypeExpr.STRING), true],
    [
      "an object carrying the TypeExpr brand (e.g. from another copy of the library)",
      { [Symbol.for("cdktn/TypeExpr")]: true },
      true,
    ],
    ["a plain object", {}, false],
    ["null", null, false],
    ["a type string", "list(string)", false],
  ])("%s -> %p", (_name, value, expected) => {
    expect(TypeExpr.isTypeExpr(value)).toBe(expected);
  });
});
