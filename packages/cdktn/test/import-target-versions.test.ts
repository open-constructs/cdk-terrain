// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Testing, TerraformStack, ImportableResource } from "../src";
import { TestProvider, TestResource } from "./helper";

function stackWith(context?: Record<string, any>) {
  const app = Testing.app({ context });
  const stack = new TerraformStack(app, "test");
  new TestProvider(stack, "provider", {});
  return stack;
}

describe("import blocks validate against targetVersions", () => {
  test("importFrom fails when the declared targets predate import blocks", () => {
    const stack = stackWith({ targetVersions: { terraform: "<1.4.0" } });
    const resource = new TestResource(stack, "test", { name: "foo" });
    resource.importFrom("testId");
    resource.importFrom("otherId");

    expect(() => Testing.synth(stack, true))
      .toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [test/test] The import block requires terraform >=1.5.0, but the project targets terraform <1.4.0.

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  test("ImportableResource fails when the declared targets predate import blocks", () => {
    const stack = stackWith({ targetVersions: { terraform: "<1.4.0" } });
    new ImportableResource(stack, "imported", {
      terraformResourceType: "test_resource",
      importId: "testId",
    });

    expect(() => Testing.synth(stack, true)).toThrow(
      "The import block requires terraform >=1.5.0, but the project targets terraform <1.4.0",
    );
  });

  test("default targets pass", () => {
    const stack = stackWith();
    new TestResource(stack, "test", { name: "foo" }).importFrom("testId");
    new ImportableResource(stack, "imported", {
      terraformResourceType: "test_resource",
      importId: "testId",
    });

    expect(() => Testing.synth(stack, true)).not.toThrow();
  });
});
