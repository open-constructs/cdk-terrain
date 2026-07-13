// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import { TerraformProviderGenerator } from "../../generator/provider-generator";
import { CodeMaker } from "codemaker";
import { createTmpHelper } from "../util";

const tmp = createTmpHelper();

test("generate a vault_alicloud_secret_backend resource with a write-only attribute", async () => {
  const code = new CodeMaker();
  const workdir = tmp("write-only.test");
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures", "write-only.test.fixture.json"),
      "utf-8",
    ),
  );
  new TerraformProviderGenerator(code, spec).generateAll();
  await code.save(workdir);

  const output = fs.readFileSync(
    path.join(workdir, "providers/vault/alicloud-secret-backend/index.ts"),
    "utf-8",
  );
  expect(output).toMatchSnapshot();

  // The write-only attribute's getter is deprecated ...
  expect(output).toMatch(
    /@deprecated Write-only: the provider never returns this value[\s\S]*?public get secretKeyWo\(\)/,
  );
  // ... its setter registers the usage of the write-only-attributes feature ...
  expect(output).toMatch(
    /public set secretKeyWo\(value: string\) \{\n\s*this\.registerProviderFeatureUsage\(cdktn\.ProviderFeature\.WRITE_ONLY_ATTRIBUTES\);/,
  );
  // ... and so does the constructor-assigned config value.
  expect(output).toMatch(
    /if \(config\.secretKeyWo !== undefined\) \{ this\.registerProviderFeatureUsage\(cdktn\.ProviderFeature\.WRITE_ONLY_ATTRIBUTES\); \}/,
  );

  // The non-write-only sibling attribute is untouched: its getter is
  // emitted directly (no @deprecated JSDoc immediately above), and its
  // setter has no registration call.
  expect(output).toMatch(
    /private _secretKeyWoVersion\?: number; \n\s*public get secretKeyWoVersion\(\)/,
  );
  expect(output).toMatch(
    /public set secretKeyWoVersion\(value: number\) \{\n\s*this\._secretKeyWoVersion = value;\n\s*\}/,
  );
});
