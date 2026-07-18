// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  App,
  ProviderFeature,
  TerraformResource,
  TerraformStack,
  Testing,
} from "../src";
import { Construct } from "constructs";
import { TestProvider } from "./helper/provider";
import { createTmpHelper } from "./helper/tmp";

const tmp = createTmpHelper();

/**
 * Stand-in for a generated resource binding that has a write-only attribute.
 * Mirrors what the provider-generator emits: the setter registers usage of
 * the "writeOnlyAttributes" provider-protocol feature family, but only when
 * the assigned value is neither `null` nor `undefined` - setting an
 * attribute to `null` is equivalent to omitting it in Terraform, and a
 * non-TypeScript jsii caller (Python `None`, Go `nil`, ...) can pass `null`
 * through even though the TypeScript setter signature itself is non-null.
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
    if (config.secretKeyWo != null) {
      this.registerProviderFeatureUsage(ProviderFeature.WRITE_ONLY_ATTRIBUTES);
    }
  }

  public set secretKeyWo(value: string) {
    if (value != null) {
      this.registerProviderFeatureUsage(ProviderFeature.WRITE_ONLY_ATTRIBUTES);
    }
    this._secretKeyWo = value;
  }

  public get secretKeyWo(): string {
    return this._secretKeyWo as string;
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
    return { secret_key_wo: this._secretKeyWo };
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

describe("registerProviderFeatureUsage", () => {
  test("feature not used: synth passes", () => {
    const { app, stack } = appWithStack();
    new TestWriteOnlyResource(stack, "testResource", {});

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

  test("repeated setter calls do not stack duplicate validations", () => {
    const { app, stack } = appWithStack({
      targetVersions: { terraform: ">=1.5.7" },
    });
    const resource = new TestWriteOnlyResource(stack, "testResource", {});
    resource.secretKeyWo = "one";
    resource.secretKeyWo = "two";
    resource.secretKeyWo = "three";

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack/testResource] write-only attributes requires terraform >=1.11.0, but the project targets terraform >=1.5.7. Write-only attributes are available in terraform >=1.11.0 and opentofu >=1.11.0.

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  test("constructor: explicit null is treated as omission, synth passes", () => {
    const { app, stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {
      secretKeyWo: null,
    });

    expect(() => app.synth()).not.toThrow();
    expect(resource.secretKeyWo).toBeUndefined();
  });

  test("constructor: a real value registers usage, synth fails", () => {
    const { app, stack } = appWithStack();
    new TestWriteOnlyResource(stack, "testResource", {
      secretKeyWo: "shh",
    });

    expect(() => app.synth()).toThrow(/write-only attributes requires/);
  });

  test("setter: assigning null is treated as omission, synth passes", () => {
    const { app, stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {});

    resource.secretKeyWo = null as unknown as string;

    expect(() => app.synth()).not.toThrow();
  });

  test("setter: assigning a real value registers usage, synth fails", () => {
    const { app, stack } = appWithStack();
    const resource = new TestWriteOnlyResource(stack, "testResource", {});

    resource.secretKeyWo = "shh";

    expect(() => app.synth()).toThrow(/write-only attributes requires/);
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
