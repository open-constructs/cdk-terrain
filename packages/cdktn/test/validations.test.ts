// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as child_process from "child_process";
import { App, Fn, TerraformStack, Testing } from "../src";

import { Construct, IValidation } from "constructs";
import { TestResource } from "./helper/resource";
import {
  checkFeatureSupportedByTargets,
  parseTerraformCliVersion,
  resolveTargetVersions,
  ValidateBinaryVersion,
  ValidateFeatureTargetSupport,
} from "../src/validations";
import { TestProvider } from "./helper/provider";
import { createTmpHelper } from "./helper/tmp";

const tmp = createTmpHelper();

test("validations are executed recursively", () => {
  const outdir = tmp("cdktf.outdir.");
  const app = Testing.stubVersion(new App({ stackTraces: false, outdir }));
  const stack = new TerraformStack(app, "MyStack");

  const validation = {
    validate: jest.fn().mockReturnValue(["custom_error_1", "custom_error_2"]),
  };
  const nestedValidation = {
    validate: jest.fn().mockReturnValue(["custom_nested_error"]),
  };
  const stackValidation = {
    validate: jest.fn().mockReturnValue(["stack_error"]),
  };

  new CustomConstruct(stack, "custom", validation, nestedValidation);
  stack.node.addValidation(stackValidation);

  expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
    "Validation failed with the following errors:
      [MyStack] stack_error
      [MyStack/custom] custom_error_1
      [MyStack/custom] custom_error_2
      [MyStack/custom/nested] custom_nested_error

    If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
    "
  `);
  expect(validation.validate).toHaveBeenCalledTimes(1);
  expect(nestedValidation.validate).toHaveBeenCalledTimes(1);
  expect(stackValidation.validate).toHaveBeenCalledTimes(1);
});

class NestedCustomConstruct extends Construct {
  constructor(scope: Construct, id: string, validation: IValidation) {
    super(scope, id);
    this.node.addValidation(validation);
  }
}

class CustomConstruct extends Construct {
  constructor(
    scope: Construct,
    id: string,
    validation: IValidation,
    nestedValidation: IValidation,
  ) {
    super(scope, id);
    this.node.addValidation(validation);
    new NestedCustomConstruct(this, "nested", nestedValidation);
  }
}

describe("ValidateBinaryVersion", () => {
  test("validates the version of a binary", () => {
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(new App({ stackTraces: false, outdir }));
    const stack = new TerraformStack(app, "MyStack");
    new TestProvider(stack, "foo", {});
    const testResource = new TestResource(stack, "testResource", {
      name: "foo",
    });
    testResource.node.addValidation(
      new ValidateBinaryVersion(
        "terraform",
        ">=1.3.0",
        `echo "Terraform v1.2.0\non darwin_amd64"`,
      ),
    );
    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack/testResource] terraform version 1.2.0 is lower than the required version >=1.3.0 for this construct. 

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  test("validation passes if the version is correct", () => {
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(new App({ stackTraces: false, outdir }));
    const stack = new TerraformStack(app, "MyStack");
    new TestProvider(stack, "foo", {});
    const testResource = new TestResource(stack, "testResource", {
      name: "foo",
    });
    testResource.node.addValidation(
      new ValidateBinaryVersion(
        "terraform",
        ">=1.2.0",
        `echo "Terraform v1.2.0\non darwin_amd64"`,
      ),
    );
    expect(() => app.synth()).not.toThrow();
  });

  test("validation fails if version command fails", () => {
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(new App({ stackTraces: false, outdir }));
    const stack = new TerraformStack(app, "MyStack");
    new TestProvider(stack, "foo", {});
    const testResource = new TestResource(stack, "testResource", {
      name: "foo",
    });
    testResource.node.addValidation(
      new ValidateBinaryVersion("terraform", ">=1.2.0", `exit 1`),
    );
    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack/testResource] Could not determine version of terraform, exit 1 failed: Error: Command failed: exit 1

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  test("validation fails if version command returns no version string", () => {
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(new App({ stackTraces: false, outdir }));
    const stack = new TerraformStack(app, "MyStack");
    new TestProvider(stack, "foo", {});
    const testResource = new TestResource(stack, "testResource", {
      name: "foo",
    });
    testResource.node.addValidation(
      new ValidateBinaryVersion("terraform", ">=1.2.0", `echo "foo"`),
    );
    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack/testResource] Could not determine version of terraform (running echo "foo")

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });
});

describe("parseTerraformCliVersion", () => {
  test("detects Terraform from the first version output line", () => {
    expect(
      parseTerraformCliVersion("Terraform v1.10.5\non linux_arm64"),
    ).toEqual({ name: "terraform", version: "1.10.5" });
  });

  test("detects OpenTofu from the first version output line", () => {
    expect(
      parseTerraformCliVersion("OpenTofu v1.10.10\non linux_arm64"),
    ).toEqual({ name: "opentofu", version: "1.10.10" });
  });

  test("does not infer the product from a matching JSON version key", () => {
    expect(
      parseTerraformCliVersion(
        JSON.stringify({
          terraform_version: "1.10.10",
          platform: "linux_arm64",
        }),
      ),
    ).toEqual({ name: "unknown", version: "1.10.10" });
  });
});

describe("resolveTargetVersions", () => {
  function stackWithContext(context?: Record<string, any>) {
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(
      new App({ stackTraces: false, outdir, context }),
    );
    return new TerraformStack(app, "MyStack");
  }

  test("defaults to the dual product baseline when undeclared", () => {
    expect(resolveTargetVersions(stackWithContext())).toEqual({
      targets: { terraform: ">=1.5.7", opentofu: ">=1.6.0" },
      errors: [],
    });
  });

  test("uses the declared targets from context", () => {
    const stack = stackWithContext({
      targetVersions: { terraform: ">=1.9.0" },
    });
    expect(resolveTargetVersions(stack)).toEqual({
      targets: { terraform: ">=1.9.0" },
      errors: [],
    });
  });

  test("reports unknown products", () => {
    const stack = stackWithContext({ targetVersions: { tofu: ">=1.6.0" } });
    expect(resolveTargetVersions(stack).errors).toEqual([
      `targetVersions has unknown product "tofu" (expected "terraform" or "opentofu")`,
    ]);
  });

  test("reports invalid semver ranges", () => {
    const stack = stackWithContext({
      targetVersions: { terraform: "latest" },
    });
    expect(resolveTargetVersions(stack).errors).toEqual([
      `targetVersions.terraform "latest" is not a valid semver range`,
    ]);
  });

  test("rejects Terraform provider constraint syntax with a hint", () => {
    const stack = stackWithContext({
      targetVersions: { terraform: "~> 1.5" },
    });
    expect(resolveTargetVersions(stack).errors).toEqual([
      `targetVersions.terraform "~> 1.5" uses Terraform provider constraint syntax; use npm semver ranges instead (e.g. ">=1.5.7" or "~1.5.7")`,
    ]);
  });

  test("reports empty declarations", () => {
    const stack = stackWithContext({ targetVersions: {} });
    expect(resolveTargetVersions(stack).errors[0]).toContain(
      "must declare at least one product",
    );
  });

  test("accepts a pinned single version as a valid range", () => {
    const stack = stackWithContext({
      targetVersions: { terraform: "1.11.0" },
    });
    expect(resolveTargetVersions(stack)).toEqual({
      targets: { terraform: "1.11.0" },
      errors: [],
    });
  });
});

describe("checkFeatureSupportedByTargets", () => {
  test("passes when the feature covers the whole declared range of each product", () => {
    expect(
      checkFeatureSupportedByTargets(
        "S3 native state locking",
        { terraform: ">=1.10.0", opentofu: ">=1.10.0" },
        { terraform: ">=1.11.0", opentofu: ">=1.10.0" },
      ),
    ).toEqual([]);
  });

  test("fails when the declared range starts below the feature's minimum", () => {
    expect(
      checkFeatureSupportedByTargets(
        "S3 native state locking",
        { terraform: ">=1.10.0" },
        { terraform: ">=1.5.7" },
      ),
    ).toEqual([
      "S3 native state locking requires terraform >=1.10.0, but the project targets terraform >=1.5.7.",
    ]);
  });

  test("evaluates each targeted product independently", () => {
    expect(
      checkFeatureSupportedByTargets(
        "S3 native state locking",
        { terraform: ">=1.11.0", opentofu: ">=1.10.0" },
        { terraform: ">=1.5.7", opentofu: ">=1.10.0" },
      ),
    ).toEqual([
      "S3 native state locking requires terraform >=1.11.0, but the project targets terraform >=1.5.7.",
    ]);
  });

  test("fails when a targeted product does not support the feature at all", () => {
    expect(
      checkFeatureSupportedByTargets(
        "ephemeral resources",
        { terraform: ">=1.10.0" },
        { terraform: ">=1.10.0", opentofu: ">=1.6.0" },
        "Remove opentofu from targetVersions to use this feature.",
      ),
    ).toEqual([
      "ephemeral resources is not supported by opentofu, but the project targets opentofu >=1.6.0. Remove opentofu from targetVersions to use this feature.",
    ]);
  });

  test("ignores products the project does not target", () => {
    expect(
      checkFeatureSupportedByTargets(
        "ephemeral resources",
        { terraform: ">=1.10.0" },
        { terraform: ">=1.10.0" },
      ),
    ).toEqual([]);
  });

  test("supports complex declared ranges via subset semantics", () => {
    expect(
      checkFeatureSupportedByTargets(
        "some feature",
        { terraform: ">=1.8.0" },
        { terraform: "1.8.x || 1.9.x" },
      ),
    ).toEqual([]);
  });

  test("passes when the declared floor is exactly the feature's minimum", () => {
    expect(
      checkFeatureSupportedByTargets(
        "some feature",
        { terraform: ">=1.8.0" },
        { terraform: ">=1.8.0" },
      ),
    ).toEqual([]);
  });

  test("passes when the project pins exactly the feature's minimum version", () => {
    expect(
      checkFeatureSupportedByTargets(
        "some feature",
        { terraform: ">=1.11.0" },
        { terraform: "1.11.0" },
      ),
    ).toEqual([]);
  });

  test("fails when the project pins a version below the minimum", () => {
    expect(
      checkFeatureSupportedByTargets(
        "some feature",
        { terraform: ">=1.11.0" },
        { terraform: "1.10.5" },
      ),
    ).toEqual([
      "some feature requires terraform >=1.11.0, but the project targets terraform 1.10.5.",
    ]);
  });

  test("fails when the declared floor is one patch below the minimum", () => {
    expect(
      checkFeatureSupportedByTargets(
        "some feature",
        { terraform: ">=1.10.0" },
        { terraform: ">=1.9.9" },
      ),
    ).toEqual([
      "some feature requires terraform >=1.10.0, but the project targets terraform >=1.9.9.",
    ]);
  });

  test("returns no errors for an empty targets object", () => {
    // Callers always resolve targets via resolveTargetVersions first, which
    // rejects {} with a "must declare at least one product" error - this
    // documents that the comparator itself just has nothing to check.
    expect(
      checkFeatureSupportedByTargets(
        "some feature",
        { terraform: ">=1.8.0" },
        {},
      ),
    ).toEqual([]);
  });

  test("treats a prerelease floor as below the minimum", () => {
    // Inherent npm-semver subset semantics: ">=1.11.0-beta1" admits
    // prerelease versions that ">=1.11.0" does not, so it is not a subset.
    // Documented here as current (intentional-if-surprising) behavior.
    expect(
      checkFeatureSupportedByTargets(
        "some feature",
        { terraform: ">=1.11.0" },
        { terraform: ">=1.11.0-beta1" },
      ),
    ).toEqual([
      "some feature requires terraform >=1.11.0, but the project targets terraform >=1.11.0-beta1.",
    ]);
  });
});

describe("ValidateFeatureTargetSupport", () => {
  function appWithStack(context?: Record<string, any>) {
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(
      new App({ stackTraces: false, outdir, context }),
    );
    const stack = new TerraformStack(app, "MyStack");
    new TestProvider(stack, "foo", {});
    const testResource = new TestResource(stack, "testResource", {
      name: "foo",
    });
    return { app, stack, testResource };
  }

  test("validates against declared targets without executing any binary", () => {
    const { app, testResource } = appWithStack({
      targetVersions: { terraform: ">=1.10.0" },
    });
    testResource.node.addValidation(
      new ValidateFeatureTargetSupport(
        testResource,
        "S3 native state locking",
        {
          terraform: ">=1.10.0",
          opentofu: ">=1.10.0",
        },
      ),
    );

    const execSpy = jest.spyOn(child_process, "execSync");
    try {
      expect(() => app.synth()).not.toThrow();
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      execSpy.mockRestore();
    }
  });

  test("fails against the default baseline when the feature needs a newer floor", () => {
    const { app, testResource } = appWithStack();
    testResource.node.addValidation(
      new ValidateFeatureTargetSupport(
        testResource,
        "S3 native state locking",
        {
          terraform: ">=1.10.0",
          opentofu: ">=1.10.0",
        },
      ),
    );

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack/testResource] S3 native state locking requires terraform >=1.10.0, but the project targets terraform >=1.5.7.
        [MyStack/testResource] S3 native state locking requires opentofu >=1.10.0, but the project targets opentofu >=1.6.0.

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  test("surfaces malformed context declarations as validation errors", () => {
    const { app, testResource } = appWithStack({
      targetVersions: { tofu: ">=1.6.0" },
    });
    testResource.node.addValidation(
      new ValidateFeatureTargetSupport(
        testResource,
        "S3 native state locking",
        {
          terraform: ">=1.10.0",
        },
      ),
    );

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack/testResource] targetVersions has unknown product "tofu" (expected "terraform" or "opentofu")

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });
});

describe("ValidateFunctionVersionSupport", () => {
  function appWithStack(context?: Record<string, any>) {
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(
      new App({ stackTraces: false, outdir, context }),
    );
    const stack = new TerraformStack(app, "MyStack");
    new TestProvider(stack, "foo", {});
    const testResource = new TestResource(stack, "testResource", {
      name: "foo",
    });
    return { app, stack, testResource };
  }

  test("ignores universally available functions without resolving targets", () => {
    const { app, stack } = appWithStack();
    new TestResource(stack, "usesBaselineFunction", {
      name: Fn.abs(-42).toString(),
    });

    const execSpy = jest.spyOn(child_process, "execSync");
    try {
      expect(() => app.synth()).not.toThrow();
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      execSpy.mockRestore();
    }
  });

  test("fails against the default baseline targets when a function needs a newer floor", () => {
    const { app, testResource } = appWithStack();
    new TestResource(testResource, "usesTemplatestring", {
      name: Fn.templatestring("$${greeting}", { greeting: "hello" }),
    });

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack] Terraform function "templatestring" requires terraform >=1.9.0, but the project targets terraform >=1.5.7. It is available in terraform >=1.9.0 and opentofu >=1.7.0.
        [MyStack] Terraform function "templatestring" requires opentofu >=1.7.0, but the project targets opentofu >=1.6.0. It is available in terraform >=1.9.0 and opentofu >=1.7.0.

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  test("passes when the declared targets are within the function's availability", () => {
    const { app, testResource } = appWithStack({
      targetVersions: { terraform: ">=1.9.0", opentofu: ">=1.7.0" },
    });
    new TestResource(testResource, "usesTemplatestring", {
      name: Fn.templatestring("$${greeting}", { greeting: "hello" }),
    });

    const execSpy = jest.spyOn(child_process, "execSync");
    try {
      expect(() => app.synth()).not.toThrow();
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      execSpy.mockRestore();
    }
  });

  test("fails with an availability hint when a targeted product does not support the function", () => {
    const { app, testResource } = appWithStack({
      targetVersions: { terraform: ">=1.15.0" },
    });
    new TestResource(testResource, "usesCidrcontains", {
      name: Fn.cidrcontains("10.0.0.0/8", "10.1.0.0").toString(),
    });

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack] Terraform function "cidrcontains" is not supported by terraform, but the project targets terraform >=1.15.0. It is available in opentofu >=1.7.0.

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  test("passes for an OpenTofu-only function when only OpenTofu is targeted", () => {
    const { app, testResource } = appWithStack({
      targetVersions: { opentofu: ">=1.7.0" },
    });
    new TestResource(testResource, "usesCidrcontains", {
      name: Fn.cidrcontains("10.0.0.0/8", "10.1.0.0").toString(),
    });

    expect(() => app.synth()).not.toThrow();
  });

  test("surfaces malformed declared targets as validation errors", () => {
    const { app, testResource } = appWithStack({
      targetVersions: { tofu: ">=1.7.0" },
    });
    new TestResource(testResource, "usesTemplatestring", {
      name: Fn.templatestring("$${greeting}", { greeting: "hello" }),
    });

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack] targetVersions has unknown product "tofu" (expected "terraform" or "opentofu")

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  // The `validateFunctionVersions` context key that used to gate this
  // validation is gone - it is registered on every stack now. `context` is an
  // untyped passthrough map, so a cdktf.json that still carries the key stays
  // valid; the key is simply inert, whichever value it holds. The two tests
  // below pin both halves of that: a stale truthy key is not an error, and a
  // falsy one no longer opts out. The literal string is spelled out here
  // because the constant it came from no longer exists.
  test("keeps working when a legacy cdktf.json still sets the removed validateFunctionVersions key", () => {
    const { app, stack } = appWithStack({ validateFunctionVersions: "true" });
    new TestResource(stack, "usesTemplatestring", {
      name: Fn.templatestring("$${greeting}", { greeting: "hello" }),
    });

    expect(() => app.synth()).toThrow(
      'Terraform function "templatestring" requires terraform >=1.9.0',
    );
  });

  test("still validates when a legacy cdktf.json explicitly disables the removed key", () => {
    const { app, stack } = appWithStack({ validateFunctionVersions: false });
    new TestResource(stack, "usesTemplatestring", {
      name: Fn.templatestring("$${greeting}", { greeting: "hello" }),
    });

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack] Terraform function "templatestring" requires terraform >=1.9.0, but the project targets terraform >=1.5.7. It is available in terraform >=1.9.0 and opentofu >=1.7.0.
        [MyStack] Terraform function "templatestring" requires opentofu >=1.7.0, but the project targets opentofu >=1.6.0. It is available in terraform >=1.9.0 and opentofu >=1.7.0.

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  test("does not leak Fn usage from one App into a later, unrelated App in the same process", () => {
    // Usage is recorded on the TerraformStack instance whose elements
    // rendered it (see TerraformStack._usedFunctions), not in a
    // process-global registry, so isolation between App trees is
    // structural, not something that depends on a reset running between
    // tests.
    const { app: app1, testResource: testResource1 } = appWithStack({
      targetVersions: { terraform: ">=1.9.0", opentofu: ">=1.7.0" },
    });
    new TestResource(testResource1, "usesTemplatestring", {
      name: Fn.templatestring("$${greeting}", { greeting: "hello" }),
    });
    expect(() => app1.synth()).not.toThrow();

    // app2 targets the default baseline (which does NOT support
    // templatestring) but never calls Fn.templatestring itself.
    const { app: app2 } = appWithStack();
    expect(() => app2.synth()).not.toThrow();
  });

  test("still fires when a second, unrelated App is constructed between usage and synth of the first (interleaved Apps)", () => {
    // Regression test against the released call-time design: recording into
    // a single process-global registry that every App constructor reset
    // meant App B's construction silently wiped out the usage App A had
    // already recorded for Fn.templatestring() before App A ever got to
    // synth() - a false negative that skipped target-version validation
    // entirely. Recording at token-RESOLVE time, onto the stack being
    // resolved, is immune to this: App A's usage is recorded during App A's
    // own prepareStack pass and read back from App A's own stacks.
    const { app: app1, testResource: testResource1 } = appWithStack();
    new TestResource(testResource1, "usesTemplatestring", {
      name: Fn.templatestring("$${greeting}", { greeting: "hello" }),
    });

    // App B is constructed here, strictly between App A's usage and App
    // A's synth() call - the interleaving that used to trigger the bug.
    appWithStack();

    expect(() => app1.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack] Terraform function "templatestring" requires terraform >=1.9.0, but the project targets terraform >=1.5.7. It is available in terraform >=1.9.0 and opentofu >=1.7.0.
        [MyStack] Terraform function "templatestring" requires opentofu >=1.7.0, but the project targets opentofu >=1.6.0. It is available in terraform >=1.9.0 and opentofu >=1.7.0.

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  // Usage lives on each TerraformStack instance (not in any registry keyed
  // by the shared App root) because ValidateFunctionVersionSupport is
  // registered with the STACK as scope and resolveTargetVersions() walks
  // context up from that scope - sibling stacks can declare different
  // targetVersions via stack-level context. Any usage store shared across
  // siblings would validate one stack's usage against a DIFFERENT sibling
  // stack's targets; here Stack2 uses a function gated to a floor it
  // doesn't declare, while Stack1 (a stricter, compatible sibling) declares
  // no usage at all - shared usage would incorrectly attribute Stack2's
  // usage check against Stack1's targets too (or vice versa).
  test("sibling stacks with different declared targets are validated independently: an incompatible stack's usage does not leak onto a compatible sibling", () => {
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(new App({ stackTraces: false, outdir }));

    const compatible = new TerraformStack(app, "CompatibleStack");
    compatible.node.setContext("targetVersions", {
      terraform: ">=1.9.0",
      opentofu: ">=1.7.0",
    });
    new TestProvider(compatible, "provider", {});
    new TestResource(compatible, "harmless", {
      name: "no gated function used here",
    });

    const incompatible = new TerraformStack(app, "IncompatibleStack");
    new TestProvider(incompatible, "provider", {});
    new TestResource(incompatible, "usesTemplatestring", {
      name: Fn.templatestring("$${greeting}", { greeting: "hello" }),
    });

    let error: Error | undefined;
    try {
      app.synth();
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toContain("[IncompatibleStack");
    expect(error!.message).not.toContain("[CompatibleStack");
  });
});
