// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  Testing,
  TerraformStack,
  TerraformVariable,
  VariableType,
  Fn,
  TerraformOutput,
} from "../src";
import { TestResource } from "./helper";
import { TestProvider } from "./helper/provider";

test("string type", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: "string",
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("number type", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: "number",
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("bool type", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: "bool",
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("any type", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: VariableType.ANY,
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("default value", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    default: "my-val",
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("null default value", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: "string",
    default: null,
  });

  expect(Testing.synth(stack)).toContain('"default": null');
});

test("null default value is preserved in HCL output", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: "string",
    default: null,
  });

  expect(Testing.synthHcl(stack)).toContain("default = null");
});

test("null nested in an object default is preserved in JSON output", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: "any",
    default: { someKey: null, list: [null, { innerKey: null }] },
  });

  const output = JSON.parse(Testing.synth(stack));
  expect(output.variable["test-variable"].default).toEqual({
    some_key: null,
    list: [null, { inner_key: null }],
  });
});

test("null nested in an object default is preserved in HCL output", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: "any",
    default: { someKey: null, list: [null, { innerKey: null }] },
  });

  expect(Testing.synthHcl(stack)).toContain(
    "default = {\nsome_key = null\nlist = [\nnull,\n{\ninner_key = null\n},\n]\n}",
  );
});

test("falsy default values are preserved in HCL output", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "bool-variable", {
    type: "bool",
    default: false,
  });
  new TerraformVariable(stack, "number-variable", {
    type: "number",
    default: 0,
  });
  new TerraformVariable(stack, "string-variable", {
    type: "string",
    default: "",
  });

  const hcl = Testing.synthHcl(stack);
  expect(hcl).toContain("default = false");
  expect(hcl).toContain("default = 0");
  expect(hcl).toContain('default = ""');
});

test("description", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    description: "A Test Variable",
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("collection type", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: "list(string)",
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("set collection type", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: VariableType.SET_NUMBER,
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("map collection type", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: VariableType.map(VariableType.BOOL),
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("tuple type", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: VariableType.tuple("bool", "list(number)"),
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("object type", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: "object({internal=number, protocol=string})",
    default: { internal: 8300, protocol: "tcp" },
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("reference", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TestProvider(stack, "provider", {});
  const variable = new TerraformVariable(stack, "test-variable", {
    type: "string",
  });

  new TestResource(stack, "test-resource", {
    name: variable.value,
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("sensitive variable", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: "string",
    sensitive: true,
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("variable with variable default", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  const a = new TerraformVariable(stack, "test-variable", {
    type: "string",
  });
  new TerraformVariable(stack, "other-variable", {
    default: a.value,
    type: "string",
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("nullable variable", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: "string",
    nullable: true,
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("variable used in template string", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  const v = new TerraformVariable(stack, "test-variable", {
    type: "string",
  });
  new TerraformOutput(stack, "test-output", {
    value: `The value is ${v}`,
  });

  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("validation block variable", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  new TerraformVariable(stack, "test-variable", {
    type: "string",
    validation: [
      {
        errorMessage: "Validation failed..",
        condition: Fn.can(Fn.regex("^ami-", "ami-test")),
      },
    ],
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});

test("validation block variable self reference", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "test");

  const variable = new TerraformVariable(stack, "test-variable", {
    type: "string",
  });
  variable.addValidation({
    condition: `${Fn.lengthOf(variable.fqn)} > 4 && ${Fn.substr(
      variable.fqn,
      0,
      4,
    )} == "ami-"`,
    errorMessage:
      'The image_id value must be a valid AMI id, starting with "ami-".',
  });
  expect(Testing.synth(stack)).toMatchSnapshot();
});
