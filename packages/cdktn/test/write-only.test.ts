// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  App,
  Lazy,
  Testing,
  TerraformResource,
  TerraformStack,
  Token,
} from "../src";
import { Construct } from "constructs";
import { TestProvider } from "./helper/provider";
import { createTmpHelper } from "./helper/tmp";

const tmp = createTmpHelper();

/**
 * Stand-in for a generated resource binding that has a write-only attribute.
 * Mirrors what the provider-generator now emits: mutation (setter/
 * constructor/reset) is a plain, unguarded assignment - no
 * `registerProviderFeatureUsage` call happens at mutation time at all.
 * Registration instead happens at *resolve* time, from inside
 * `synthesizeAttributes()`, by wrapping the mapped value in
 * `this.markWriteOnlyAttribute(...)` (see AttributesEmitter#emitToTerraform
 * and TerraformResource#markWriteOnlyAttribute). Validation therefore
 * derives from what actually renders, not from whether a setter was ever
 * called with a non-null value.
 */
class TestWriteOnlyResource extends TerraformResource {
  private _secretKeyWo?: string;

  constructor(
    scope: Construct,
    id: string,
    config: { secretKeyWo?: string | null },
  ) {
    super(scope, id, {
      terraformResourceType: "test_write_only_resource",
    });
    this._secretKeyWo = config.secretKeyWo ?? undefined;
  }

  public set secretKeyWo(value: string) {
    this._secretKeyWo = value;
  }

  public get secretKeyWo(): string {
    return this._secretKeyWo as string;
  }

  public resetSecretKeyWo() {
    this._secretKeyWo = undefined;
  }

  /**
   * Exposes the protected hook directly, for the "unknown feature" test.
   * Models what a plain-JS or non-TypeScript jsii caller could pass despite
   * the ProviderFeature enum in the signature.
   */
  public callWithUnknownFeature() {
    (this as any).registerProviderFeatureUsage("notARealFeature");
  }

  protected synthesizeAttributes(): { [name: string]: any } {
    return {
      secret_key_wo: this.markWriteOnlyAttribute(this._secretKeyWo),
    };
  }
}

function appWithStack(context?: Record<string, any>) {
  const outdir = tmp("cdktf.outdir.");
  const app = Testing.stubVersion(
    new App({ stackTraces: false, outdir, context }),
  );
  const stack = new TerraformStack(app, "MyStack");
  new TestProvider(stack, "foo", {});
  return { app, stack };
}

/**
 * Reads back the write-only attribute of the single `testResource` from the
 * fully resolved (but not validated) synthesized JSON - i.e. what actually
 * renders, independent of whether target-version validation would pass or
 * fail.
 */
function synthesizedSecretKeyWo(stack: TerraformStack): unknown {
  const tfConfig = JSON.parse(Testing.synth(stack));
  return tfConfig.resource?.test_write_only_resource?.testResource
    ?.secret_key_wo;
}

describe("registerProviderFeatureUsage (write-only attributes)", () => {
  test("feature not used: synth passes", () => {
    const { app, stack } = appWithStack();
    new TestWriteOnlyResource(stack, "testResource", {});

    expect(synthesizedSecretKeyWo(stack)).toBeUndefined();
    expect(() => app.synth()).not.toThrow();
  });

  test("default targets: synth fails naming terraform and opentofu floors with a hint", () => {
    const { app, stack } = appWithStack();
    new TestWriteOnlyResource(stack, "testResource", {
      secretKeyWo: "shh",
    });

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack/testResource] write-only attributes requires terraform >=1.11.0, but the project targets terraform >=1.5.7. Write-only attributes are available in terraform >=1.11.0 and opentofu >=1.11.0.
        [MyStack/testResource] write-only attributes requires opentofu >=1.11.0, but the project targets opentofu >=1.6.0. Write-only attributes are available in terraform >=1.11.0 and opentofu >=1.11.0.

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  test("targets covering the feature floor: synth passes", () => {
    const { app, stack } = appWithStack({
      targetVersions: { terraform: ">=1.11.0", opentofu: ">=1.11.0" },
    });
    new TestWriteOnlyResource(stack, "testResource", {
      secretKeyWo: "shh",
    });

    expect(() => app.synth()).not.toThrow();
  });

  test("a single app.synth() call (prepareStack's preparing resolve + the synthesizer's final resolve) does not stack duplicate validations", () => {
    // App.synth() itself performs two resolve passes over every element's
    // toTerraform() - prepareStack's preparing pass, then the synthesizer's
    // final render - so even a single synth() call resolves (and so
    // registers) markWriteOnlyAttribute's wrapper twice. The dedup Set on
    // TerraformElement must collapse that into one validation, one error
    // line.
    const { app, stack } = appWithStack({
      targetVersions: { terraform: ">=1.5.7" },
    });
    new TestWriteOnlyResource(stack, "testResource", {
      secretKeyWo: "shh",
    });

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack/testResource] write-only attributes requires terraform >=1.11.0, but the project targets terraform >=1.5.7. Write-only attributes are available in terraform >=1.11.0 and opentofu >=1.11.0.

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  // (a) non-null setter value then explicit null before synth. Assigning a
  // literal `null` through the (raw-assignment) setter renders as an
  // explicit JSON `null` - Terraform's own "omit this attribute" spelling,
  // distinct from the key being absent entirely - but either way the
  // resolved value is not-a-real-value, so it must not register/arm the
  // validation.
  test("setter: value then cleared with null before synth: attribute nulled out, synth passes", () => {
    const { app, stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {});
    resource.secretKeyWo = "shh";
    resource.secretKeyWo = null as unknown as string;

    expect(synthesizedSecretKeyWo(stack)).toBeNull();
    expect(() => app.synth()).not.toThrow();
  });

  // (b) non-null setter value then reset before synth
  test("setter: value then reset before synth: attribute omitted, synth passes", () => {
    const { app, stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {});
    resource.secretKeyWo = "shh";
    resource.resetSecretKeyWo();

    expect(synthesizedSecretKeyWo(stack)).toBeUndefined();
    expect(() => app.synth()).not.toThrow();
  });

  // (c) non-null constructor value then reset before synth
  test("constructor: value then reset before synth: attribute omitted, synth passes", () => {
    const { app, stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {
      secretKeyWo: "shh",
    });
    resource.resetSecretKeyWo();

    expect(synthesizedSecretKeyWo(stack)).toBeUndefined();
    expect(() => app.synth()).not.toThrow();
  });

  // (d) value present at synth
  test("setter: a real value present at synth: attribute renders, synth fails", () => {
    const { app, stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {});
    resource.secretKeyWo = "shh";

    expect(synthesizedSecretKeyWo(stack)).toBe("shh");
    expect(() => app.synth()).toThrow(/write-only attributes requires/);
  });

  test("constructor: a real value present at synth: attribute renders, synth fails", () => {
    const { app, stack } = appWithStack();
    new TestWriteOnlyResource(stack, "testResource", {
      secretKeyWo: "shh",
    });

    expect(synthesizedSecretKeyWo(stack)).toBe("shh");
    expect(() => app.synth()).toThrow(/write-only attributes requires/);
  });

  // (e) re-set after clearing re-arms the validation
  test("re-setting a value after clearing it fails again (re-arm)", () => {
    const { app, stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {});
    resource.secretKeyWo = "shh";
    resource.secretKeyWo = null as unknown as string;
    // If registration were still sticky/event-based, clearing above would
    // have permanently armed the validation regardless of what happens
    // next. It must not: only the FINAL, rendered value matters.
    resource.secretKeyWo = "shh again";

    expect(synthesizedSecretKeyWo(stack)).toBe("shh again");
    expect(() => app.synth()).toThrow(/write-only attributes requires/);
  });

  // (f) a Lazy/IResolvable producer - the token case that motivated this
  // design: at setter-call time, the value is always a non-null token
  // string, so an event-based "value != null" guard cannot tell whether the
  // producer will actually contribute anything until resolve time.
  test("Lazy producer resolving to undefined: attribute omitted, synth passes", () => {
    const { app, stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {});
    resource.secretKeyWo = Lazy.stringValue({ produce: () => undefined });

    expect(synthesizedSecretKeyWo(stack)).toBeUndefined();
    expect(() => app.synth()).not.toThrow();
  });

  test("Lazy producer resolving to a string: attribute renders, synth fails", () => {
    const { app, stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {});
    resource.secretKeyWo = Lazy.stringValue({ produce: () => "lazy-shh" });

    expect(synthesizedSecretKeyWo(stack)).toBe("lazy-shh");
    expect(() => app.synth()).toThrow(/write-only attributes requires/);
  });

  // (g) explicit null from the start
  test("constructor: explicit null from the start is treated as omission, synth passes", () => {
    const { app, stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {
      secretKeyWo: null,
    });

    expect(resource.secretKeyWo).toBeUndefined();
    expect(synthesizedSecretKeyWo(stack)).toBeUndefined();
    expect(() => app.synth()).not.toThrow();
  });

  test("setter: assigning null (never having set a real value) is treated as omission, synth passes", () => {
    const { app, stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {});

    resource.secretKeyWo = null as unknown as string;

    expect(synthesizedSecretKeyWo(stack)).toBeNull();
    expect(() => app.synth()).not.toThrow();
  });

  test("a token that RESOLVES to null (cdktn.Token.nullValue()) is treated as omission too, synth passes", () => {
    // Unlike a literal `null`, `Token.nullValue()` is an IResolvable, so it
    // does get wrapped by markWriteOnlyAttribute() - this pins that the
    // wrapper's resolve-time nullish check treats the RESOLVED value as the
    // Terraform-semantics source of truth: a token resolving to `null`
    // renders as an explicit null-out and must not arm the validation, same
    // as assigning `null` directly.
    const { app, stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {});

    resource.secretKeyWo = Token.nullValue() as unknown as string;

    expect(() => app.synth()).not.toThrow();
    expect(synthesizedSecretKeyWo(stack)).toBeNull();
  });

  test("unknown feature key throws", () => {
    const { stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {});

    expect(() =>
      resource.callWithUnknownFeature(),
    ).toThrowErrorMatchingInlineSnapshot(
      `"Unknown provider-protocol feature "notARealFeature" passed to registerProviderFeatureUsage. This is an internal cdktn API intended to be called by generated provider bindings, not user code; if you did not call it directly, please file a bug report."`,
    );
  });
});

// markWriteOnlyAttribute's registration is only ever discovered by a
// prepare step (TerraformStack._runPreparingResolve). Every
// validation-enabled entry point must run that prepare step itself before
// validating, not just App.synth() - otherwise a write-only value that
// violates the declared targets silently renders without ever being
// flagged. And because the registration this discovers represents only the
// CURRENT synthesis pass, repeat synthesis of the same App/stack must
// neither leak a stale registration into a pass where the value is no
// longer present, nor stack up duplicate validations across passes.
describe("resolve-discovered write-only usage: entry points and synthesis epochs", () => {
  test("Testing.synth(stack, true) surfaces an old-target write-only failure", () => {
    const { stack } = appWithStack();
    new TestWriteOnlyResource(stack, "testResource", { secretKeyWo: "shh" });

    expect(() => Testing.synth(stack, true)).toThrow(
      /write-only attributes requires/,
    );
  });

  test("Testing.synthHcl(stack, true) surfaces an old-target write-only failure", () => {
    const { stack } = appWithStack();
    new TestWriteOnlyResource(stack, "testResource", { secretKeyWo: "shh" });

    expect(() => Testing.synthHcl(stack, true)).toThrow(
      /write-only attributes requires/,
    );
  });

  test("direct StackSynthesizer/stack synthesis without App.synth() surfaces an old-target write-only failure", () => {
    const { stack } = appWithStack();
    new TestWriteOnlyResource(stack, "testResource", { secretKeyWo: "shh" });

    // Testing.fullSynth() drives stack.synthesizer.synthesize() directly
    // with a bare session that never sets `stacksPrepared` - the same shape
    // any hand-rolled IStackSynthesizer caller (not going through
    // App.synth()) would build.
    expect(() => Testing.fullSynth(stack)).toThrow(
      /write-only attributes requires/,
    );
  });

  test("repeat synthesis of the same App: clearing the write-only value between synths lets the second pass succeed", () => {
    const { app, stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {
      secretKeyWo: "shh",
    });

    expect(() => app.synth()).toThrow(/write-only attributes requires/);

    resource.resetSecretKeyWo();

    expect(() => app.synth()).not.toThrow();
  });

  test("repeat synthesis of the same App: a Lazy producer returning a value on the first synth and undefined on the second - second synth passes", () => {
    const { app, stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {});
    let produceValue = true;
    resource.secretKeyWo = Lazy.stringValue({
      produce: () => (produceValue ? "lazy-shh" : undefined),
    });

    expect(() => app.synth()).toThrow(/write-only attributes requires/);

    produceValue = false;

    expect(() => app.synth()).not.toThrow();
  });

  test("re-activating the same registration across repeated synthesis passes still yields exactly one error line per targeted product, not a growing stack of duplicates", () => {
    const { app, stack } = appWithStack();
    new TestWriteOnlyResource(stack, "testResource", { secretKeyWo: "shh" });

    for (let i = 0; i < 3; i++) {
      let message = "";
      try {
        app.synth();
      } catch (e: any) {
        message = e.message as string;
      }
      const errorLines = message
        .split("\n")
        .filter((line) => line.includes("write-only attributes requires"));
      // one line per targeted product (terraform + opentofu) - never more,
      // no matter how many prior passes re-activated this same element's
      // registration.
      expect(errorLines).toHaveLength(2);
    }
  });
});

/**
 * Mirrors what generated `synthesizeHclAttributes()` emits for HCL
 * synthesis: a per-attribute descriptor `{ value, isBlock, type,
 * storageClassType }` (see `AttributesEmitter#emitToHclTerraform`), gated
 * by the generator's own "remove undefined attributes" pre-filter -
 * `value !== undefined && value.value !== undefined` - which only inspects
 * the *unresolved* value. A token (write-only-wrapped or not) is never
 * itself `undefined`, so it survives that pre-filter even when it will go
 * on to *resolve* to `undefined`.
 *
 * When that happens, generic `resolve()` (tokens/private/resolve.ts) deep-
 * resolves the descriptor object and silently drops just the `value` key
 * (the one key whose resolution can legitimately come back `undefined`),
 * leaving a bare `{ isBlock, type, storageClassType }` shell for
 * `renderAttributes()` (hcl/render.ts) to deal with. Previously it fell
 * through to `renderFuzzyJsonExpression()` and rendered that leftover
 * metadata as a bogus assignment; it must now omit the attribute entirely
 * instead, exactly as if it had never been set.
 */
class TestHclDescriptorResource extends TerraformResource {
  public secretKeyWo?: any;
  public plainAttr?: any;

  constructor(
    scope: Construct,
    id: string,
    config: { secretKeyWo?: any; plainAttr?: any },
  ) {
    super(scope, id, {
      terraformResourceType: "test_hcl_descriptor_resource",
    });
    this.secretKeyWo = config.secretKeyWo;
    this.plainAttr = config.plainAttr;
  }

  protected synthesizeHclAttributes(): { [name: string]: any } {
    return Object.fromEntries(
      Object.entries({
        // write-only: value wrapped in markWriteOnlyAttribute(), exactly
        // as generated bindings do.
        secret_key_wo: {
          value: this.markWriteOnlyAttribute(this.secretKeyWo),
          isBlock: false,
          type: "simple",
          storageClassType: "string",
        },
        // not write-only at all - pins that the fix is general, per the
        // #313 HCL-defects family, not specific to the write-only marker.
        plain_attr: {
          value: this.plainAttr,
          isBlock: false,
          type: "simple",
          storageClassType: "string",
        },
      }).filter(
        ([_, value]) => value !== undefined && value.value !== undefined,
      ),
    );
  }
}

function hclForDescriptorResource(config: {
  secretKeyWo?: any;
  plainAttr?: any;
}): string {
  const { stack } = appWithStack();
  new TestHclDescriptorResource(stack, "testResource", config);
  return Testing.synthHcl(stack);
}

describe("renderAttributes (HCL synthesis): a descriptor whose value resolves to undefined", () => {
  test("write-only attribute wrapped by markWriteOnlyAttribute: Lazy resolving to undefined - attribute entirely absent, no leaked metadata", () => {
    const hcl = hclForDescriptorResource({
      secretKeyWo: Lazy.stringValue({ produce: () => undefined }),
    });

    expect(hcl).not.toMatch(/secret_key_wo/);
    expect(hcl).not.toMatch(/isBlock/);
    expect(hcl).not.toMatch(/storageClassType/);
    // the storage type name itself must not leak either (pre-fix, this
    // rendered as `storageClassType = "string"` via renderFuzzyJsonObject)
    expect(hcl).not.toMatch(/storageClassType\s*=\s*"string"/);
  });

  test("write-only attribute: Lazy resolving to a real string still renders normally", () => {
    const hcl = hclForDescriptorResource({
      secretKeyWo: Lazy.stringValue({ produce: () => "shh" }),
    });

    expect(hcl).toMatch(/secret_key_wo\s*=\s*"shh"/);
  });

  // Requirement 2: only the *absent*-value case is omitted - an explicit
  // `null` must keep rendering as an explicit null assignment.
  test("write-only attribute: explicit null still renders as an explicit null, not omitted", () => {
    const hcl = hclForDescriptorResource({ secretKeyWo: null });

    expect(hcl).toMatch(/secret_key_wo\s*=\s*null/);
  });

  // General case (not write-only specific): any attribute descriptor whose
  // value is a plain (unwrapped) token resolving to undefined must also be
  // omitted, with no leaked descriptor metadata.
  test("plain (non-write-only) attribute: token resolving to undefined - attribute entirely absent, no leaked metadata", () => {
    const hcl = hclForDescriptorResource({
      plainAttr: Lazy.anyValue({ produce: () => undefined }),
    });

    expect(hcl).not.toMatch(/plain_attr/);
    expect(hcl).not.toMatch(/isBlock/);
    expect(hcl).not.toMatch(/storageClassType/);
    expect(hcl).not.toMatch(/storageClassType\s*=\s*"string"/);
  });

  test("plain (non-write-only) attribute: token resolving to a real value still renders normally", () => {
    const hcl = hclForDescriptorResource({
      plainAttr: Lazy.anyValue({ produce: () => "value" }),
    });

    expect(hcl).toMatch(/plain_attr\s*=\s*"value"/);
  });
});
