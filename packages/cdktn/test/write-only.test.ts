// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { App, Lazy, Testing, TerraformResource, TerraformStack } from "../src";
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

  // (g) explicit null from the start (previous round's semantics, preserved)
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
