// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { App, Testing, TerraformStack } from "../src";
import { ref } from "../src/tfExpression";
import { DataResource } from "../src/terraform-data-resource";
import { createTmpHelper } from "./helper/tmp";

const tmp = createTmpHelper();

test("built-in Terraform data resource", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new DataResource(stack, "test-data", {
    input: ref("var.input"),
    triggersReplace: [ref("var.triggersReplace1"), ref("var.triggersReplace2")],
  });

  // Note: the triggers_replace attribute is defined as dynamic in the schema,
  // which is treated as an object by the CDKTN provider generation and therefore
  // renders the array as a map instead.
  expect(Testing.synth(stack)).toMatchInlineSnapshot(`
    "{
      "resource": {
        "terraform_data": {
          "test-data": {
            "input": "\${var.input}",
            "triggers_replace": {
              "0": "\${var.triggersReplace1}",
              "1": "\${var.triggersReplace2}"
            }
          }
        }
      }
    }"
  `);
});

describe("targetVersions validation", () => {
  function appWithStack(context?: Record<string, any>) {
    const app = Testing.stubVersion(
      new App({ stackTraces: false, outdir: tmp("cdktf.outdir."), context }),
    );
    const stack = new TerraformStack(app, "MyStack");
    return { app, stack };
  }

  test("fails when the declared terraform target is below the minimum", () => {
    const { app, stack } = appWithStack({
      targetVersions: { terraform: "<1.4.0" },
    });
    new DataResource(stack, "test-data", { input: { a: "b" } });

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
     "Validation failed with the following errors:
       [MyStack/test-data] The terraform_data resource requires terraform >=1.4.0, but the project targets terraform <1.4.0.

     If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
     "
    `);
  });

  test("passes against the default targets", () => {
    const { app, stack } = appWithStack();
    new DataResource(stack, "test-data", { input: { a: "b" } });

    expect(() => app.synth()).not.toThrow();
  });
});
