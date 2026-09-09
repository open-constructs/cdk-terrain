// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import { CodeMaker } from "codemaker";
import { TerraformProviderGenerator } from "../../generator/provider-generator";
import { sanitizeClassOrNamespaceName } from "../../generator/resource-parser";
import { createTmpHelper } from "../util";

const tmp = createTmpHelper();

// A provider declaring provider-defined functions emits them to
// providers/<provider>/provider-functions/index.ts. A resource named
// <provider>_provider_functions maps to that same directory, so without a
// guard the resource overwrites the functions wrapper and the provider index
// exports the name twice.
describe("resource named like the provider functions submodule", () => {
  let workdir: string;

  beforeAll(async () => {
    const code = new CodeMaker();
    workdir = tmp("provider-functions-name-collision.test");
    const spec = JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          "fixtures",
          "provider-functions-name-collision.test.fixture.json",
        ),
        "utf-8",
      ),
    );
    new TerraformProviderGenerator(code, spec).generateAll();
    await code.save(workdir);
  });

  const read = (relPath: string) =>
    fs.readFileSync(path.join(workdir, relPath), "utf-8");

  test("the functions submodule holds the functions wrapper, not the resource", () => {
    const output = read("providers/example/provider-functions/index.ts");
    expect(output).toContain("class ExampleProviderFunctions");
    expect(output).not.toContain("cdktn.TerraformResource");
  });

  test("the resource is emitted to its own directory", () => {
    const output = read(
      "providers/example/provider-functions-resource/index.ts",
    );
    expect(output).toContain("class ProviderFunctionsResource");
    expect(output).toContain("cdktn.TerraformResource");
  });

  test("the provider index exports both, without duplicate names", () => {
    const index = read("providers/example/index.ts");
    expect(index).toContain(
      "export * as providerFunctions from './provider-functions/index';",
    );
    expect(index).toContain(
      "export * as providerFunctionsResource from './provider-functions-resource/index';",
    );

    const exportedNames = [...index.matchAll(/export \* as (\w+) from/g)].map(
      (m) => m[1],
    );
    expect(new Set(exportedNames).size).toBe(exportedNames.length);
  });
});

describe("sanitizeClassOrNamespaceName", () => {
  test("suffixes a resource named provider_functions", () => {
    expect(sanitizeClassOrNamespaceName("provider_functions")).toBe(
      "provider_functions_resource",
    );
  });

  test("still suffixes a resource named provider", () => {
    expect(sanitizeClassOrNamespaceName("provider")).toBe("provider_resource");
  });

  test("leaves an unrelated resource name alone", () => {
    expect(sanitizeClassOrNamespaceName("function_app")).toBe("function_app");
  });
});
