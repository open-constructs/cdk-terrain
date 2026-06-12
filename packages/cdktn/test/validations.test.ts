// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as child_process from "child_process";
import { App, TerraformStack, Testing } from "../src";

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
import { terraformBinaryName } from "../src/util";

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
