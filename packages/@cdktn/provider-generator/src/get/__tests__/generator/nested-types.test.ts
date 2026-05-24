// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import { CodeMaker } from "codemaker";
import { TerraformProviderGenerator } from "../../generator/provider-generator";
import { createTmpHelper } from "../util";

const tmp = createTmpHelper();

test("generate a resource with nested types", async () => {
  const code = new CodeMaker();
  const workdir = tmp("nested-types.test");
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures", "nested-types.test.fixture.json"),
      "utf-8",
    ),
  );
  new TerraformProviderGenerator(code, spec).generateAll();
  await code.save(workdir);

  const output = fs.readFileSync(
    path.join(workdir, "providers/test/nested-types-resource/index.ts"),
    "utf-8",
  );
  expect(output).toMatchSnapshot();
});

test("generate a resource with nested type and no attributes", async () => {
  const code = new CodeMaker();
  const workdir = tmp("nested-type-without-attributes.test");
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "fixtures",
        "nested-type-without-attributes.test.fixture.json",
      ),
      "utf-8",
    ),
  );
  new TerraformProviderGenerator(code, spec).generateAll();
  await code.save(workdir);

  const output = fs.readFileSync(
    path.join(
      workdir,
      "providers/test/nested-type-without-attributes-resource/index.ts",
    ),
    "utf-8",
  );
  expect(output).toMatchSnapshot();
});
