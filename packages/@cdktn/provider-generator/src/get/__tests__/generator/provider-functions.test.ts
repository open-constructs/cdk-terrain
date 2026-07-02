// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import { TerraformProviderGenerator } from "../../generator/provider-generator";
import { CodeMaker } from "codemaker";
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
