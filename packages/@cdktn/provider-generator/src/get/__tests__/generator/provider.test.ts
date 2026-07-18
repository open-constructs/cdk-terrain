// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import { TerraformProviderGenerator } from "../../generator/provider-generator";
import { CodeMaker } from "codemaker";
import { createTmpHelper } from "../util";

const tmp = createTmpHelper();

test("generate provider", async () => {
  const code = new CodeMaker();
  const workdir = tmp("provider.test");
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures", "aws-provider.test.fixture.json"),
      "utf-8",
    ),
  );
  new TerraformProviderGenerator(code, spec).generateAll();
  await code.save(workdir);

  const output = fs.readFileSync(
    path.join(workdir, "providers/aws/provider/index.ts"),
    "utf-8",
  );
  expect(output).toMatchSnapshot();
  // aws has no provider-defined functions in this fixture - no getter, no
  // cross-directory import should be emitted.
  expect(output).not.toContain("public get functions()");
  expect(output).not.toContain("provider-functions");
});

test("generate provider with only block_types", async () => {
  const code = new CodeMaker();
  const workdir = tmp("provider.test");
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "fixtures",
        "elasticstack-provider.test.fixture.json",
      ),
      "utf-8",
    ),
  );
  new TerraformProviderGenerator(code, spec).generateAll();
  await code.save(workdir);

  const output = fs.readFileSync(
    path.join(workdir, "providers/elasticstack/provider/index.ts"),
    "utf-8",
  );
  expect(output).toMatchSnapshot();
  // elasticstack has no provider-defined functions in this fixture - no
  // getter, no cross-directory import should be emitted.
  expect(output).not.toContain("public get functions()");
  expect(output).not.toContain("provider-functions");
});
