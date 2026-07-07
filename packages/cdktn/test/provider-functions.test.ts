// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  App,
  Testing,
  Tokenization,
  TerraformOutput,
  TerraformStack,
} from "../src";
import { TerraformProviderFunction } from "../src/functions/provider-function";
import { resetProviderFunctionUsageRegistry } from "../src/functions/usage-registry";
import { createTmpHelper } from "./helper/tmp";
import { TestProvider, TestResource } from "./helper";

const tmp = createTmpHelper();

beforeEach(() => {
  resetProviderFunctionUsageRegistry();
});

test("invoke() renders provider::<name>::<function>(...) in synthesized output", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformOutput(stack, "test-output", {
    value: TerraformProviderFunction.invoke("time", "rfc3339_parse", [
      "2023-01-01T00:00:00Z",
    ]),
  });

  expect(Testing.synth(stack)).toMatchInlineSnapshot(`
    "{
      "output": {
        "test-output": {
          "value": "\${provider::time::rfc3339_parse(\\"2023-01-01T00:00:00Z\\")}"
        }
      }
    }"
  `);
});

// Bug 1 regression: dynamic/object/map-typed generated wrappers used to
// force-coerce the invoke() result through `cdktn.Token.asString(...)`,
// which produces a value `Tokenization.isResolvable()` does not recognize -
// silently dropping the attribute wherever a generated struct setter
// (OutputReference internalValue) inspects the value's keys. The raw
// invoke() result must stay a recognizable `IResolvable`.
test("invoke() result is recognized as an IResolvable (not force-coerced through Token.asString)", () => {
  const result = TerraformProviderFunction.invoke("time", "rfc3339_parse", [
    "2023-01-01T00:00:00Z",
  ]);

  expect(Tokenization.isResolvable(result)).toBe(true);
});

test("invoke() result passed as a resource attribute survives synth as a provider::... expression", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TestProvider(stack, "provider", {});
  new TestResource(stack, "test", {
    name: "foo",
    anyMap: {
      parsed: TerraformProviderFunction.invoke("time", "rfc3339_parse", [
        "2023-01-01T00:00:00Z",
      ]),
    },
  });

  const { any_map: anyMap } = JSON.parse(Testing.synth(stack)).resource
    .test_resource.test;
  expect(anyMap.parsed).toBe(
    '${provider::time::rfc3339_parse("2023-01-01T00:00:00Z")}',
  );
});

// Bug 2 regression: invoke() used to flatten/validate args through
// variadic(anyValue), whose underlying listOf() filters out null/undefined
// ENTRIES - correct for a genuinely variadic trailing list, wrong for a
// fixed-arity positional call, where a literal `null` in the middle is a
// meaningful argument (Terraform errors "Missing value for value_if_false"
// when it silently disappears).
describe("invoke() preserves null/undefined positional arguments", () => {
  test("a literal null in the second position renders as three comma-separated arguments with a literal null", () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, "test");

    new TerraformOutput(stack, "test-output", {
      value: TerraformProviderFunction.invoke("cfncompat", "condition_if", [
        true,
        null,
        { a: 1 },
      ]),
    });

    const { value } = JSON.parse(Testing.synth(stack)).output["test-output"];
    expect(value).toMatch(
      /provider::cfncompat::condition_if\(true, null, \{"a" = 1\}\)/,
    );
  });

  test("an undefined value in the second position also renders as a literal null", () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, "test");

    new TerraformOutput(stack, "test-output", {
      value: TerraformProviderFunction.invoke("cfncompat", "condition_if", [
        true,
        undefined,
        { a: 1 },
      ]),
    });

    const { value } = JSON.parse(Testing.synth(stack)).output["test-output"];
    expect(value).toMatch(
      /provider::cfncompat::condition_if\(true, null, \{"a" = 1\}\)/,
    );
  });
});

describe("ValidateProviderFunctionTargetSupport", () => {
  function appWithStack(context?: Record<string, any>) {
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(
      new App({ stackTraces: false, outdir, context }),
    );
    const stack = new TerraformStack(app, "MyStack");
    return { app, stack };
  }

  test("fails against the default baseline targets when a provider function is used", () => {
    const { app, stack } = appWithStack();
    new TerraformOutput(stack, "test-output", {
      value: TerraformProviderFunction.invoke("time", "rfc3339_parse", [
        "2023-01-01T00:00:00Z",
      ]),
    });

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack] provider-defined functions (provider::time::rfc3339_parse) requires terraform >=1.8.0, but the project targets terraform >=1.5.7. Provider-defined functions are available in terraform >=1.8.0 and opentofu >=1.7.0.
        [MyStack] provider-defined functions (provider::time::rfc3339_parse) requires opentofu >=1.7.0, but the project targets opentofu >=1.6.0. Provider-defined functions are available in terraform >=1.8.0 and opentofu >=1.7.0.

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  test("passes when the declared targets satisfy provider function support", () => {
    const { app, stack } = appWithStack({
      targetVersions: { terraform: ">=1.8.0", opentofu: ">=1.7.0" },
    });
    new TerraformOutput(stack, "test-output", {
      value: TerraformProviderFunction.invoke("time", "rfc3339_parse", [
        "2023-01-01T00:00:00Z",
      ]),
    });

    expect(() => app.synth()).not.toThrow();
  });

  test("passes on default targets when no provider function is used", () => {
    const { app } = appWithStack();
    expect(() => app.synth()).not.toThrow();
  });

  test("does not leak provider function usage from one App into a later, unrelated App in the same process", () => {
    // Deliberately does NOT rely on the top-level beforeEach reset running
    // between app1 and app2: both apps are constructed within this single
    // test, so the only thing preventing app1's usage from leaking into
    // app2's validation is the reset that happens in App's own constructor.
    const { app: app1, stack: stack1 } = appWithStack({
      targetVersions: { terraform: ">=1.8.0", opentofu: ">=1.7.0" },
    });
    new TerraformOutput(stack1, "test-output", {
      value: TerraformProviderFunction.invoke("time", "rfc3339_parse", [
        "2023-01-01T00:00:00Z",
      ]),
    });
    expect(() => app1.synth()).not.toThrow();

    // app2 targets the default baseline (which does NOT support
    // provider-defined functions) but never invokes one itself.
    const { app: app2 } = appWithStack();
    expect(() => app2.synth()).not.toThrow();
  });

  test("app2 does not report provider-defined function errors carried over from app1's usage", () => {
    const { app: app1, stack: stack1 } = appWithStack({
      targetVersions: { terraform: ">=1.8.0", opentofu: ">=1.7.0" },
    });
    new TerraformOutput(stack1, "test-output", {
      value: TerraformProviderFunction.invoke("time", "rfc3339_parse", [
        "2023-01-01T00:00:00Z",
      ]),
    });
    expect(() => app1.synth()).not.toThrow();

    const { app: app2 } = appWithStack();
    try {
      app2.synth();
    } catch (e: any) {
      expect(e.message).not.toContain("provider-defined functions");
    }
  });
});
