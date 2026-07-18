// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import { TerraformProviderGenerator } from "../../generator/provider-generator";
import {
  assertNoFunctionsGetterCollision,
  buildProviderFunctionsModel,
} from "../../generator/models/provider-function-model";
import { CodeMaker } from "codemaker";
import { FunctionSignature } from "@cdktn/commons";
import { createTmpHelper } from "../util";

const tmp = createTmpHelper();

test("generate provider functions for the time provider (real terraform 1.15.6 schema fragment)", async () => {
  const code = new CodeMaker();
  const workdir = tmp("provider-functions.test");
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures", "provider-functions.test.fixture.json"),
      "utf-8",
    ),
  );
  new TerraformProviderGenerator(code, spec).generateAll();
  await code.save(workdir);

  const providerFunctionsOutput = fs.readFileSync(
    path.join(workdir, "providers/time/provider-functions/index.ts"),
    "utf-8",
  );
  expect(providerFunctionsOutput).toMatchSnapshot("time-provider-functions");

  const providerOutput = fs.readFileSync(
    path.join(workdir, "providers/time/provider/index.ts"),
    "utf-8",
  );
  expect(providerOutput).toMatchSnapshot("time-provider");

  const providerIndex = fs.readFileSync(
    path.join(workdir, "providers/time/index.ts"),
    "utf-8",
  );
  expect(providerIndex).toMatchSnapshot("provider-index");

  const providerLazyIndex = fs.readFileSync(
    path.join(workdir, "providers/time/lazy-index.ts"),
    "utf-8",
  );
  expect(providerLazyIndex).toMatchSnapshot("provider-lazy-index");
});

test("generate provider functions covering variadic parameters, primitive/list returns, and a 'default' parameter name", async () => {
  const code = new CodeMaker();
  const workdir = tmp("provider-functions-synthetic.test");
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "fixtures",
        "provider-functions-synthetic.test.fixture.json",
      ),
      "utf-8",
    ),
  );
  new TerraformProviderGenerator(code, spec).generateAll();
  await code.save(workdir);

  const providerFunctionsOutput = fs.readFileSync(
    path.join(workdir, "providers/example/provider-functions/index.ts"),
    "utf-8",
  );
  expect(providerFunctionsOutput).toMatchSnapshot("example-provider-functions");

  const providerIndex = fs.readFileSync(
    path.join(workdir, "providers/example/index.ts"),
    "utf-8",
  );
  expect(providerIndex).toMatchSnapshot("provider-index");

  const providerLazyIndex = fs.readFileSync(
    path.join(workdir, "providers/example/lazy-index.ts"),
    "utf-8",
  );
  expect(providerLazyIndex).toMatchSnapshot("provider-lazy-index");
});

test("buildProviderFunctionsModel throws when two function names collapse to the same generated method name", () => {
  expect(() =>
    buildProviderFunctionsModel("example", {
      foo_bar: { return_type: "string", parameters: [] },
      foo__bar: { return_type: "string", parameters: [] },
    }),
  ).toThrow(/foo_bar/);
  expect(() =>
    buildProviderFunctionsModel("example", {
      foo_bar: { return_type: "string", parameters: [] },
      foo__bar: { return_type: "string", parameters: [] },
    }),
  ).toThrow(/foo__bar/);
});

test("buildProviderFunctionsModel throws when two parameter names collapse within one function", () => {
  expect(() =>
    buildProviderFunctionsModel("example", {
      my_function: {
        return_type: "string",
        parameters: [
          { name: "some_value", type: "string" },
          { name: "some__value", type: "string" },
        ],
      },
    }),
  ).toThrow(/some_value/);
  expect(() =>
    buildProviderFunctionsModel("example", {
      my_function: {
        return_type: "string",
        parameters: [
          { name: "some_value", type: "string" },
          { name: "some__value", type: "string" },
        ],
      },
    }),
  ).toThrow(/some__value/);
});

// Both of these assert the model-level throw happens before any file is
// generated: buildProviderFunctionsModel is called directly, with no
// CodeMaker/generator involved, so there is no emission step to reach.
test("buildProviderFunctionsModel throws when a function name sanitizes to 'constructor'", () => {
  // The nested signature literal is cast to `FunctionSignature` (rather than
  // relying on contextual typing from the surrounding index signature)
  // because TypeScript special-cases a property literally named
  // "constructor" - contextually typing it against `Function` (from
  // `Object.prototype`) instead of the index signature's `FunctionSignature`,
  // and spuriously flagging `return_type: "string"` as an error. See
  // https://github.com/microsoft/TypeScript/issues/40776.
  const signature: FunctionSignature = {
    return_type: "string",
    parameters: [],
  };
  expect(() =>
    buildProviderFunctionsModel("example", {
      constructor: signature,
    }),
  ).toThrow(/constructor/);
  expect(() =>
    buildProviderFunctionsModel("example", {
      constructor: signature,
    }),
  ).toThrow(/example/);
});

test("buildProviderFunctionsModel throws when a function name sanitizes to 'providerLocalName'", () => {
  expect(() =>
    buildProviderFunctionsModel("example", {
      provider_local_name: { return_type: "string", parameters: [] },
    }),
  ).toThrow(/provider_local_name/);
  expect(() =>
    buildProviderFunctionsModel("example", {
      provider_local_name: { return_type: "string", parameters: [] },
    }),
  ).toThrow(/providerLocalName/);
});

test("assertNoFunctionsGetterCollision throws when the provider's own config schema would generate a 'functions' property", () => {
  expect(() =>
    assertNoFunctionsGetterCollision("example", ["alias", "functions"]),
  ).toThrow(/"functions"/);
});

test("assertNoFunctionsGetterCollision does not throw when there is no colliding attribute", () => {
  expect(() =>
    assertNoFunctionsGetterCollision("example", ["alias"]),
  ).not.toThrow();
});

test("generation throws when a provider's config attribute collides with the generated 'functions' getter", async () => {
  const code = new CodeMaker();
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "fixtures",
        "provider-functions-collision.test.fixture.json",
      ),
      "utf-8",
    ),
  );
  expect(() =>
    new TerraformProviderGenerator(code, spec).generateAll(),
  ).toThrow(/"functions"/);
});
