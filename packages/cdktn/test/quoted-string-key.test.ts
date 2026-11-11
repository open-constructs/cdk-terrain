// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from "constructs";
import { Fn, Testing, TerraformLocal, TerraformStack, Token } from "../src";
import { quotedStringKey } from "../src/hcl/quoted-string-key";
import { renderMap } from "../src/hcl/render";
import { call, Expression } from "../src/tfExpression";
import { resolve } from "../src/_tokens";
import { TestResource } from "./helper";

const stack = new TerraformStack(new Construct(undefined as any, "scope"), "s");
const resolveExpression = (expr: Expression) => resolve(stack, expr);

describe("quotedStringKey", () => {
  it.each([
    ["plain", `"plain"`],
    ['he"llo', `"he\\"llo"`],
    ["a\\b", `"a\\\\b"`],
    ["${injected}", `"$\${injected}"`],
    ["%{if x}", `"%%{if x}"`],
    ["line\nbreak", `"line\\nbreak"`],
    ["back\bspace", `"back\\u0008space"`],
    ["form\ffeed", `"form\\u000cfeed"`],
    ["\\b", `"\\\\b"`],
  ])("serializes %j", (key, expected) => {
    expect(quotedStringKey(key)).toBe(expected);
  });
});

describe("object keys in expressions", () => {
  it.each([
    ['he"llo', `{"he\\"llo" = "x"}`],
    ["${injected}", `{"$\${injected}" = "x"}`],
    ["a\\b", `{"a\\\\b" = "x"}`],
  ])("escapes the key %j of a direct object argument", (key, expected) => {
    expect(resolveExpression(call("lookup", [{ [key]: "x" }]))).toBe(
      `\${lookup(${expected})}`,
    );
  });

  it("escapes the key of an object wrapped in a token", () => {
    expect(
      resolveExpression(call("lookup", [Token.asAny({ 'he"llo': "x" })])),
    ).toBe(`\${lookup({"he\\"llo" = "x"})}`);
  });

  it("renders a pure token key as a parenthesised key expression", () => {
    const res = new TestResource(stack, "object-keys-pure", {
      name: "test",
    });
    expect(resolveExpression(call("merge", [{ [res.stringValue]: "v" }]))).toBe(
      `\${merge({(test_resource.object-keys-pure.string_value) = "v"})}`,
    );
  });

  it("renders a mixed literal/token key as a parenthesised interpolation", () => {
    const res = new TestResource(stack, "object-keys-mixed", {
      name: "test",
    });
    expect(
      resolveExpression(call("merge", [{ [`pre-${res.stringValue}`]: "w" }])),
    ).toBe(
      `\${merge({("pre-\${test_resource.object-keys-mixed.string_value}") = "w"})}`,
    );
  });

  it("escapes a quote in the literal fragment of a mixed key", () => {
    const res = new TestResource(stack, "object-keys-mixed-quote", {
      name: "test",
    });
    expect(
      resolveExpression(
        call("merge", [{ [`prefix"-${res.stringValue}`]: "w" }]),
      ),
    ).toBe(
      `\${merge({("prefix\\"-\${test_resource.object-keys-mixed-quote.string_value}") = "w"})}`,
    );
  });

  it("escapes a backslash in the literal fragment of a mixed key", () => {
    const res = new TestResource(stack, "object-keys-mixed-backslash", {
      name: "test",
    });
    expect(
      resolveExpression(call("merge", [{ [`a\\b-${res.stringValue}`]: "w" }])),
    ).toBe(
      `\${merge({("a\\\\b-\${test_resource.object-keys-mixed-backslash.string_value}") = "w"})}`,
    );
  });
});

describe("map keys in the HCL renderer", () => {
  it("keeps bare identifiers unquoted", () => {
    expect(renderMap({ simple_key: "x" })).toBe(`{\nsimple_key = "x"\n}`);
  });

  it.each([
    ['he"llo', `"he\\"llo"`],
    ["a\\b", `"a\\\\b"`],
    ["with space", `"with space"`],
  ])("quotes the key %j", (key, expected) => {
    expect(renderMap({ [key]: "x" })).toBe(`{\n${expected} = "x"\n}`);
  });

  it("keeps a function-token key with a quoted string literal parseable", () => {
    const app = Testing.app();
    const localStack = new TerraformStack(app, "test");

    new TerraformLocal(localStack, "m", { [Fn.lower("ABC")]: "v" });

    const hcl = Testing.synthHcl(localStack);
    expect(hcl).toContain(`"\${lower("ABC")}" = "v"`);
  });

  it("keeps a resource-reference key as an interpolation", () => {
    const app = Testing.app();
    const localStack = new TerraformStack(app, "test");
    const res = new TestResource(localStack, "res", { name: "test" });

    new TerraformLocal(localStack, "m", { [res.stringValue]: "v" });

    const hcl = Testing.synthHcl(localStack);
    expect(hcl).toContain(`"\${test_resource.res.string_value}" = "v"`);
  });
});
