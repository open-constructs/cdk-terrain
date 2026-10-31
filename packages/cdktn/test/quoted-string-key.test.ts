// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from "constructs";
import { TerraformStack, Token } from "../src";
import { quotedStringKey } from "../src/hcl/quoted-string-key";
import { renderMap } from "../src/hcl/render";
import { call, Expression } from "../src/tfExpression";
import { resolve } from "../src/_tokens";

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
});

describe("map keys in the HCL renderer", () => {
  it("keeps bare identifiers unquoted", () => {
    expect(renderMap({ simple_key: "x" })).toBe(`{\nsimple_key = "x"\n}`);
  });

  it.each([
    ['he"llo', `"he\\"llo"`],
    ["${reference}", `"\${reference}"`],
    ["a\\b", `"a\\\\b"`],
    ["with space", `"with space"`],
  ])("quotes the key %j and keeps token references", (key, expected) => {
    expect(renderMap({ [key]: "x" })).toBe(`{\n${expected} = "x"\n}`);
  });
});
