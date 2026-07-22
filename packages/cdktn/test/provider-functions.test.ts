// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  App,
  Testing,
  Token,
  Tokenization,
  TerraformOutput,
  TerraformStack,
} from "../src";
import { TerraformProviderFunction } from "../src/functions/provider-function";
import { createTmpHelper } from "./helper/tmp";
import { TestProvider, TestResource } from "./helper";

const tmp = createTmpHelper();

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

// invoke() must not flatten/validate its args through variadic(anyValue):
// the underlying listOf() filters out null/undefined ENTRIES - correct for
// a genuinely variadic trailing list, wrong for a fixed-arity positional
// call, where a literal `null` in the middle is a meaningful argument
// (Terraform errors "Missing value for value_if_false" when it silently
// disappears).
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

  // A generated nullable fixed parameter's type unions in
  // `cdktn.IResolvable` specifically so a caller can pass
  // `cdktn.Token.nullValue()` in that position (see `applyNullability` in
  // provider-function-model.ts). `Token.nullValue()` is `Token.asAny(null)`
  // - an `IResolvable` that resolves to `null` - so this pins, at the
  // runtime primitive every generated wrapper method calls through to, that
  // passing it in a FIXED positional slot renders the bare Terraform `null`
  // keyword in that slot, same as a literal `null`/`undefined` above, rather
  // than e.g. a quoted string or an unresolved token expression.
  test("cdktn.Token.nullValue() passed as a fixed positional argument renders the bare null keyword in that position", () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, "test");

    new TerraformOutput(stack, "test-output", {
      value: TerraformProviderFunction.invoke("cfncompat", "condition_if", [
        true,
        Token.nullValue(),
        { a: 1 },
      ]),
    });

    const { value } = JSON.parse(Testing.synth(stack)).output["test-output"];
    expect(value).toMatch(
      /provider::cfncompat::condition_if\(true, null, \{"a" = 1\}\)/,
    );
  });
});

// Proves - at the `TerraformProviderFunction.invoke()` primitive every
// generated wrapper method is a thin call-through to - the two runtime
// mechanics the generated types rely on being sound:
// generated parameter types that union in a whole-collection
// `cdktn.IResolvable` token actually synthesize correctly when given one,
// and a raw `IResolvable` returned by one invoke() call composes correctly
// as an argument into a second invoke() call (the same shape a generated
// method returning e.g. `set(bool)`/`map(string)` feeding into another
// generated method's parameter of that type would produce). There is no
// TypeScript-compiling harness in this repository for generated provider
// bindings (see the composition tests in
// packages/@cdktn/provider-generator's provider-functions.test.ts for the
// generator-side structural assertions on the emitted declaration text).
describe("whole-collection tokens and invoke()-to-invoke() composition", () => {
  test("a whole-collection IResolvable token (e.g. standing in for a list(bool)/set(bool) parameter) synthesizes as its resolved value, not as an opaque token expression", () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, "test");

    new TerraformOutput(stack, "test-output", {
      value: TerraformProviderFunction.invoke("example", "flag_set", [
        Token.asAny([true, false]),
      ]),
    });

    const { value } = JSON.parse(Testing.synth(stack)).output["test-output"];
    expect(value).toBe("${provider::example::flag_set([true, false])}");
  });

  test("a whole-collection token resolving to a map escapes keys containing quotes, backslashes, and template markers into valid quoted-string literals", () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, "test");

    new TerraformOutput(stack, "test-output", {
      value: TerraformProviderFunction.invoke("example", "flag_map", [
        Token.asAny({
          'he"llo': "a",
          "back\\slash": "b",
          "${interp}": "c",
          "%{directive}": "d",
        }),
      ]),
    });

    // Keys are serialized as Terraform quoted-string literals: quotes,
    // backslashes and control characters JSON-escaped, `${`/`%{` rendered
    // via Terraform's own `$${`/`%%{` escapes so the literal key doesn't
    // become a template interpolation/directive sequence. (The pre-existing
    // direct-object branch is not covered here - see
    // https://github.com/open-constructs/cdk-terrain/issues/350.)
    const { value } = JSON.parse(Testing.synth(stack)).output["test-output"];
    expect(value).toBe(
      '${provider::example::flag_map({"he\\"llo" = "a", "back\\\\slash" = "b", "$${interp}" = "c", "%%{directive}" = "d"})}',
    );
  });

  test("the raw IResolvable one invoke() call returns composes correctly as an argument into a second invoke() call", () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, "test");

    const innerResult = TerraformProviderFunction.invoke(
      "example",
      "flags_for_seed",
      ["a-seed"],
    );
    new TerraformOutput(stack, "test-output", {
      value: TerraformProviderFunction.invoke("example", "flag_set", [
        innerResult,
      ]),
    });

    const { value } = JSON.parse(Testing.synth(stack)).output["test-output"];
    expect(value).toBe(
      '${provider::example::flag_set(provider::example::flags_for_seed("a-seed"))}',
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
    // Usage is recorded per-App-root (the resolving stack's `node.root`)
    // rather than in a single process-global registry, so isolation between
    // App trees is structural, not something that depends on a reset
    // running between tests.
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

  test("still fires when a second, unrelated App is constructed between usage and synth of the first (interleaved Apps)", () => {
    // Guards the interleaved-Apps scenario the released built-in `Fn.*`
    // usage tracking got wrong (see the matching test in
    // validations.test.ts): with call-time recording into a process-global
    // registry that every App constructor reset, App B's construction
    // silently wiped out the usage App A had already recorded before App A
    // ever got to synth() - a false negative that skipped target-version
    // validation entirely. Provider-function usage is recorded at
    // token-RESOLVE time onto the stack being resolved, so App B's
    // construction cannot touch App A's usage.
    const { app: app1, stack: stack1 } = appWithStack();
    new TerraformOutput(stack1, "test-output", {
      value: TerraformProviderFunction.invoke("time", "rfc3339_parse", [
        "2023-01-01T00:00:00Z",
      ]),
    });

    // App B is constructed here, strictly between App A's usage and App
    // A's synth() call - the interleaving a process-global design breaks on.
    appWithStack();

    expect(() => app1.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack] provider-defined functions (provider::time::rfc3339_parse) requires terraform >=1.8.0, but the project targets terraform >=1.5.7. Provider-defined functions are available in terraform >=1.8.0 and opentofu >=1.7.0.
        [MyStack] provider-defined functions (provider::time::rfc3339_parse) requires opentofu >=1.7.0, but the project targets opentofu >=1.6.0. Provider-defined functions are available in terraform >=1.8.0 and opentofu >=1.7.0.

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });
});

// Same entry-point requirement as resolve-discovered write-only usage (see
// write-only.test.ts): usage is only ever discovered by a prepare step that
// resolves every element's toTerraform(), so every validation-enabled entry
// point - not just App.synth() - must run that step itself before
// validating. And because usage represents only the CURRENT synthesis pass,
// repeat synthesis of the same App must not let a function rendered in an
// earlier pass keep failing a later pass where it no longer appears.
describe("resolve-discovered provider-function usage: entry points and synthesis epochs", () => {
  function appWithStack(context?: Record<string, any>) {
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(
      new App({ stackTraces: false, outdir, context }),
    );
    const stack = new TerraformStack(app, "MyStack");
    return { app, stack };
  }

  function addGatedProviderFunctionOutput(stack: TerraformStack) {
    return new TerraformOutput(stack, "test-output", {
      value: TerraformProviderFunction.invoke("time", "rfc3339_parse", [
        "2023-01-01T00:00:00Z",
      ]),
    });
  }

  test("Testing.synth(stack, true) surfaces the target failure for a gated provider function", () => {
    const { stack } = appWithStack();
    addGatedProviderFunctionOutput(stack);

    expect(() => Testing.synth(stack, true)).toThrow(
      /provider-defined functions/,
    );
  });

  test("Testing.synthHcl(stack, true) surfaces the target failure for a gated provider function", () => {
    const { stack } = appWithStack();
    addGatedProviderFunctionOutput(stack);

    expect(() => Testing.synthHcl(stack, true)).toThrow(
      /provider-defined functions/,
    );
  });

  test("direct StackSynthesizer/stack synthesis without App.synth() surfaces the target failure for a gated provider function", () => {
    const { stack } = appWithStack();
    addGatedProviderFunctionOutput(stack);

    // Testing.fullSynth() drives stack.synthesizer.synthesize() directly
    // with a bare session that never sets `stacksPrepared`.
    expect(() => Testing.fullSynth(stack)).toThrow(
      /provider-defined functions/,
    );
  });

  test("removing the gated output and re-synthesizing the same App passes (function-usage epoch)", () => {
    const { app, stack } = appWithStack();
    const output = addGatedProviderFunctionOutput(stack);

    expect(() => app.synth()).toThrow(/provider-defined functions/);

    stack.node.tryRemoveChild(output.node.id);

    expect(() => app.synth()).not.toThrow();
  });

  test("multi-stack App.synth(): preparing stack2 does not erase provider-function usage stack1 already recorded", () => {
    // Usage is recorded and read per-stack (`TerraformStack._usedFunctions`
    // / `_usedProviderFunctions`), each cleared by that stack's own
    // `_runPreparingResolve()` - so this scenario holds structurally:
    // stack1's usage lives entirely on stack1 and nothing stack2's
    // preparation does can touch it. The coverage pins exactly that
    // per-stack ownership: any design sharing usage state across stacks
    // (e.g. one registry on the App with a single shared reset) has to
    // reason about *when* the shared reset runs relative to each stack's
    // preparation - with per-stack ownership there is no shared state to
    // race.
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(new App({ stackTraces: false, outdir }));
    const stack1 = new TerraformStack(app, "Stack1");
    const stack2 = new TerraformStack(app, "Stack2");

    addGatedProviderFunctionOutput(stack1);
    new TerraformOutput(stack2, "unrelated-output", { value: "just a stack" });

    expect(() => app.synth()).toThrow(/provider-defined functions/);
  });
});

// Usage lives on each TerraformStack instance, not in a registry keyed by
// the shared App root. This matters because
// ValidateProviderFunctionTargetSupport is registered in TerraformStack's
// constructor with the STACK as scope, and resolveTargetVersions() walks
// context up FROM that scope - so sibling stacks can declare different
// targetVersions via stack-level context. Usage shared across siblings
// would validate one stack's usage against a sibling's targets, producing
// false positives
// (an unrelated, compatible sibling failing because of a stricter sibling's
// targets) and false negatives (a genuinely incompatible stack passing
// because a compatible sibling's usage happened to satisfy the check).
describe("stack-owned usage: sibling stacks with independent targetVersions", () => {
  function appWithStacks() {
    const outdir = tmp("cdktf.outdir.");
    return Testing.stubVersion(new App({ stackTraces: false, outdir }));
  }

  function gatedProviderFunctionValue() {
    return TerraformProviderFunction.invoke("time", "rfc3339_parse", [
      "2023-01-01T00:00:00Z",
    ]);
  }

  test("app.synth() passes when a compatible stack uses the function and an incompatible sibling never does", () => {
    const app = appWithStacks();

    const compatible = new TerraformStack(app, "CompatibleStack");
    compatible.node.setContext("targetVersions", {
      terraform: ">=1.8.0",
      opentofu: ">=1.7.0",
    });
    new TerraformOutput(compatible, "gated-output", {
      value: gatedProviderFunctionValue(),
    });

    const incompatible = new TerraformStack(app, "IncompatibleStack");
    new TerraformOutput(incompatible, "unrelated-output", {
      value: "no provider function used here",
    });

    expect(() => app.synth()).not.toThrow();
  });

  test("app.synth() fails with only the incompatible stack's error when its compatible sibling never uses the function", () => {
    const app = appWithStacks();

    const compatible = new TerraformStack(app, "CompatibleStack");
    compatible.node.setContext("targetVersions", {
      terraform: ">=1.8.0",
      opentofu: ">=1.7.0",
    });
    new TerraformOutput(compatible, "harmless-output", {
      value: "no provider function used here",
    });

    const incompatible = new TerraformStack(app, "IncompatibleStack");
    new TerraformOutput(incompatible, "gated-output", {
      value: gatedProviderFunctionValue(),
    });

    let error: Error | undefined;
    try {
      app.synth();
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toContain("provider-defined functions");
    expect(error!.message).toContain("[IncompatibleStack]");
    expect(error!.message).not.toContain("[CompatibleStack]");
  });

  test("a single shared token rendered into both stacks' outputs is attributed to each stack independently", () => {
    const app = appWithStacks();
    const stackA = new TerraformStack(app, "StackA");
    const stackB = new TerraformStack(app, "StackB");

    // The exact same token/IResolvable instance, resolved once per stack
    // (each stack has its own preparing-resolve pass over its own
    // elements) - proving that recording happens per RESOLVE, attributed to
    // whichever stack is doing the resolving, not just once for whichever
    // stack happens to resolve it first.
    const sharedValue = gatedProviderFunctionValue();
    new TerraformOutput(stackA, "output-a", { value: sharedValue });
    new TerraformOutput(stackB, "output-b", { value: sharedValue });

    // Both stacks target the (incompatible) default baseline, and each is
    // validated independently of the other (Testing.synth's resolve/reset
    // discovery step targets a single stack), so both fail.
    expect(() => Testing.synth(stackA, true)).toThrow(
      /provider-defined functions/,
    );
    expect(() => Testing.synth(stackB, true)).toThrow(
      /provider-defined functions/,
    );
  });
});
