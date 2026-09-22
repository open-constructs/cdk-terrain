// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { App, TerraformStack, Testing } from "../src";
import { TestProvider, TestResource } from "./helper";
import { createTmpHelper } from "./helper/tmp";

const tmp = createTmpHelper();

function appWithMove(context?: Record<string, any>) {
  const app = Testing.stubVersion(
    new App({ stackTraces: false, outdir: tmp("cdktf.outdir."), context }),
  );
  const stack = new TerraformStack(app, "MyStack");
  new TestProvider(stack, "provider", {});
  new TestResource(stack, "source", { name: "foo" }).moveTo("target");
  new TestResource(stack, "destination", { name: "foo" }).addMoveTarget(
    "target",
  );
  return app;
}

describe("resource moves validate against declared targetVersions", () => {
  test("targets below the feature floor: synth fails", () => {
    const app = appWithMove({ targetVersions: { terraform: "<1.4.0" } });

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
     "Validation failed with the following errors:
       [MyStack] The moved block requires terraform >=1.5.0, but the project targets terraform <1.4.0.

     If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
     "
    `);
  });

  test("default targets: synth passes", () => {
    const app = appWithMove();

    expect(() => app.synth()).not.toThrow();
  });

  test("default targets: moveFromId synth passes", () => {
    const app = Testing.stubVersion(
      new App({ stackTraces: false, outdir: tmp("cdktf.outdir.") }),
    );
    const stack = new TerraformStack(app, "MyStack");
    new TestProvider(stack, "provider", {});
    new TestResource(stack, "moved", { name: "foo" }).moveFromId(
      "test_resource.old",
    );

    expect(() => app.synth()).not.toThrow();
  });
});
