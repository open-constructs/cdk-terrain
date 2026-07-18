// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from "constructs";
import { App, Testing, TerraformStack, TerraformOutput } from "../src";
import {
  TerraformEphemeralResource,
  TerraformEphemeralResourceConfig,
} from "../src/terraform-ephemeral-resource";
import { TestProvider } from "./helper/provider";
import { createTmpHelper } from "./helper/tmp";

const tmp = createTmpHelper();

interface TestEphemeralResourceConfig extends TerraformEphemeralResourceConfig {
  name?: string;
}

class TestEphemeralResource extends TerraformEphemeralResource {
  public name?: string;

  constructor(
    scope: Construct,
    id: string,
    config: Omit<TestEphemeralResourceConfig, "terraformResourceType"> = {},
  ) {
    super(scope, id, {
      terraformResourceType: "test_ephemeral",
      ...config,
    });
    this.name = config.name;
  }

  protected synthesizeAttributes(): { [name: string]: any } {
    return { name: this.name };
  }

  protected synthesizeHclAttributes(): { [name: string]: any } {
    return {
      name: {
        value: this.name,
        type: "simple",
        storageClassType: "string",
      },
    };
  }

  public get token() {
    return this.getStringAttribute("token");
  }
}

test("synthesizes under the top-level ephemeral key", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");
  new TestProvider(stack, "provider", {});

  new TestEphemeralResource(stack, "test", { name: "foo" });

  expect(Testing.synth(stack)).toMatchInlineSnapshot(`
    "{
      "ephemeral": {
        "test_ephemeral": {
          "test": {
            "name": "foo"
          }
        }
      },
      "provider": {
        "test": [
          {}
        ]
      },
      "terraform": {
        "required_providers": {
          "test": {
            "version": "~> 2.0"
          }
        }
      }
    }"
  `);
});

test("renders an ephemeral HCL block", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TestEphemeralResource(stack, "test", { name: "foo" });

  expect(Testing.synthHcl(stack)).toMatchInlineSnapshot(`
    "
    ephemeral "test_ephemeral" "test" {
    name = "foo"
    }"
  `);
});

test("renders a precondition lifecycle block", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");
  new TestProvider(stack, "provider", {});

  new TestEphemeralResource(stack, "test", {
    name: "foo",
    lifecycle: {
      precondition: [
        {
          condition: '${var.foo != ""}',
          errorMessage: "foo must not be empty",
        },
      ],
    },
  });

  expect(Testing.synth(stack)).toMatchInlineSnapshot(`
    "{
      "ephemeral": {
        "test_ephemeral": {
          "test": {
            "lifecycle": {
              "precondition": [
                {
                  "condition": "\${var.foo != \\"\\"}",
                  "error_message": "foo must not be empty"
                }
              ]
            },
            "name": "foo"
          }
        }
      },
      "provider": {
        "test": [
          {}
        ]
      },
      "terraform": {
        "required_providers": {
          "test": {
            "version": "~> 2.0"
          }
        }
      }
    }"
  `);
});

test("interpolationForAttribute produces ephemeral.-prefixed references", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  const resource = new TestEphemeralResource(stack, "test", { name: "foo" });
  new TerraformOutput(stack, "token-output", { value: resource.token });

  expect(JSON.parse(Testing.synth(stack)).output["token-output"].value).toEqual(
    "${ephemeral.test_ephemeral.test.token}",
  );
});

describe("ephemeral resource target version validation", () => {
  function appWithStack(context?: Record<string, any>) {
    const outdir = tmp("cdktf.outdir.");
    const app = Testing.stubVersion(
      new App({ stackTraces: false, outdir, context }),
    );
    const stack = new TerraformStack(app, "MyStack");
    return { app, stack };
  }

  test("fails against the default baseline targets", () => {
    const { app, stack } = appWithStack();
    new TestEphemeralResource(stack, "testResource", { name: "foo" });

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack/testResource] ephemeral resources requires terraform >=1.10.0, but the project targets terraform >=1.5.7. Ephemeral resources are available in terraform >=1.10.0 and opentofu >=1.11.0.
        [MyStack/testResource] ephemeral resources requires opentofu >=1.11.0, but the project targets opentofu >=1.6.0. Ephemeral resources are available in terraform >=1.10.0 and opentofu >=1.11.0.

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  test("passes when the declared terraform target meets the minimum", () => {
    const { app, stack } = appWithStack({
      targetVersions: { terraform: ">=1.10.0" },
    });
    new TestEphemeralResource(stack, "testResource", { name: "foo" });

    expect(() => app.synth()).not.toThrow();
  });

  test("fails when the declared opentofu target is below the minimum", () => {
    const { app, stack } = appWithStack({
      targetVersions: { opentofu: ">=1.6.0" },
    });
    new TestEphemeralResource(stack, "testResource", { name: "foo" });

    expect(() => app.synth()).toThrowErrorMatchingInlineSnapshot(`
      "Validation failed with the following errors:
        [MyStack/testResource] ephemeral resources requires opentofu >=1.11.0, but the project targets opentofu >=1.6.0. Ephemeral resources are available in terraform >=1.10.0 and opentofu >=1.11.0.

      If you wish to ignore these validations, pass 'skipValidation: true' to your App configuration.
      "
    `);
  });

  test("passes when both declared targets meet the minimums", () => {
    const { app, stack } = appWithStack({
      targetVersions: { terraform: ">=1.10.0", opentofu: ">=1.11.0" },
    });
    new TestEphemeralResource(stack, "testResource", { name: "foo" });

    expect(() => app.synth()).not.toThrow();
  });

  // Round 6, Finding 3: registrations made via the plain (structural)
  // `registerProviderFeatureUsage` - the element's mere existence is the
  // usage, as here in TestEphemeralResource's constructor - are never
  // deactivated by the per-synthesis-pass reset that resolve-discovered
  // registrations (e.g. markWriteOnlyAttribute) go through. So, unlike a
  // write-only attribute that can be cleared between passes, an ephemeral
  // resource must keep failing old targets on every single synth of the
  // same App for as long as it exists in the construct tree.
  test("structural registration survives synthesis epochs: still fails old targets on a second synth of the same App", () => {
    const { app, stack } = appWithStack();
    new TestEphemeralResource(stack, "testResource", { name: "foo" });

    expect(() => app.synth()).toThrow(/ephemeral resources requires/);
    expect(() => app.synth()).toThrow(/ephemeral resources requires/);
  });
});
