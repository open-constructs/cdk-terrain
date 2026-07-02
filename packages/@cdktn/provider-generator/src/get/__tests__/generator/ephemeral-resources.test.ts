// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import { TerraformProviderGenerator } from "../../generator/provider-generator";
import { CodeMaker } from "codemaker";
import { createTmpHelper } from "../util";

const tmp = createTmpHelper();

test("generate an ephemeral random_password resource alongside a regular random_uuid resource", async () => {
  const code = new CodeMaker();
  const workdir = tmp("ephemeral.test");
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures", "ephemeral-resources.test.fixture.json"),
      "utf-8",
    ),
  );
  new TerraformProviderGenerator(code, spec).generateAll();
  await code.save(workdir);

  const ephemeralOutput = fs.readFileSync(
    path.join(workdir, "providers/random/ephemeral-random-password/index.ts"),
    "utf-8",
  );
  expect(ephemeralOutput).toMatchSnapshot("ephemeral-random-password");

  const resourceOutput = fs.readFileSync(
    path.join(workdir, "providers/random/uuid/index.ts"),
    "utf-8",
  );
  expect(resourceOutput).toMatchSnapshot("random-uuid");

  const providerIndex = fs.readFileSync(
    path.join(workdir, "providers/random/index.ts"),
    "utf-8",
  );
  expect(providerIndex).toMatchSnapshot("provider-index");

  const providerLazyIndex = fs.readFileSync(
    path.join(workdir, "providers/random/lazy-index.ts"),
    "utf-8",
  );
  expect(providerLazyIndex).toMatchSnapshot("provider-lazy-index");
});
