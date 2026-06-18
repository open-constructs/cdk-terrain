// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { App, TerraformStack, Testing } from "../src";

import { Construct, IValidation } from "constructs";
import { TestResource } from "./helper/resource";
import {
  parseTerraformCliVersion,
  ValidateBinaryVersion,
  ValidateTerraformFeatureVersion,
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

describe("ValidateTerraformFeatureVersion", () => {
  test("passes when the detected Terraform version satisfies the feature matrix", () => {
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(new App({ stackTraces: false, outdir }));
    const stack = new TerraformStack(app, "MyStack");
    new TestProvider(stack, "foo", {});
    const testResource = new TestResource(stack, "testResource", {
      name: "foo",
    });
    testResource.node.addValidation(
      new ValidateTerraformFeatureVersion(
        "S3 native state locking",
        {
          terraform: ">=1.10.0",
          opentofu: ">=1.10.0",
        },
        `echo "Terraform v1.10.5\non linux_arm64"`,
      ),
    );

    expect(() => app.synth()).not.toThrow();
  });

  test("fails with the product-specific constraint when Terraform is too old", () => {
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(new App({ stackTraces: false, outdir }));
    const stack = new TerraformStack(app, "MyStack");
    new TestProvider(stack, "foo", {});
    const testResource = new TestResource(stack, "testResource", {
      name: "foo",
    });
    testResource.node.addValidation(
      new ValidateTerraformFeatureVersion(
        "S3 native state locking",
        {
          terraform: ">=1.10.0",
          opentofu: ">=1.9.0",
        },
        `echo "Terraform v1.7.5\non linux_arm64"`,
      ),
    );

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack/testResource] S3 native state locking requires terraform >=1.10.0, but terraform version 1.7.5 was found.

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  test("uses the OpenTofu constraint when OpenTofu is detected", () => {
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(new App({ stackTraces: false, outdir }));
    const stack = new TerraformStack(app, "MyStack");
    new TestProvider(stack, "foo", {});
    const testResource = new TestResource(stack, "testResource", {
      name: "foo",
    });
    testResource.node.addValidation(
      new ValidateTerraformFeatureVersion(
        "S3 native state locking",
        {
          terraform: ">=1.12.0",
          opentofu: ">=1.10.0",
        },
        `echo "OpenTofu v1.10.10\non linux_arm64"`,
      ),
    );

    expect(() => app.synth()).not.toThrow();
  });

  test("fails when the CLI product cannot be detected from the first line", () => {
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(new App({ stackTraces: false, outdir }));
    const stack = new TerraformStack(app, "MyStack");
    new TestProvider(stack, "foo", {});
    const testResource = new TestResource(stack, "testResource", {
      name: "foo",
    });
    testResource.node.addValidation(
      new ValidateTerraformFeatureVersion(
        "S3 native state locking",
        {
          terraform: ">=1.10.0",
          opentofu: ">=1.10.0",
        },
        `echo '{"terraform_version":"1.10.10"}'`,
      ),
    );

    const binaryName = terraformBinaryName;

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack/testResource] Could not determine whether ${binaryName} is Terraform or OpenTofu from the first line of ${binaryName} version output: {\"terraform_version\":\"1.10.10\"}

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });
});
