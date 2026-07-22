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
  // ... its setter is a plain assignment ...
  expect(output).toMatch(
    /public set secretKeyWo\(value: string\) \{\n\s*this\._secretKeyWo = value;\n\s*\}/,
  );
  // ... and usage registration happens at resolve time, from inside
  // synthesizeAttributes()/synthesizeHclAttributes(), by wrapping the
  // mapped value in markWriteOnlyAttribute() ...
  expect(output).toMatch(
    /secret_key_wo: this\.markWriteOnlyAttribute\(cdktn\.stringToTerraform\(this\._secretKeyWo\)\),/,
  );
  expect(output).toMatch(
    /value: this\.markWriteOnlyAttribute\(cdktn\.stringToHclTerraform\(this\._secretKeyWo\)\),/,
  );

  // The required write-only attribute gets no reset method (required
  // attributes never do) ...
  expect(output).not.toMatch(/resetSecretKeyWo\b/);
  // ... but the OPTIONAL write-only sibling does, exercising the reset ->
  // clear -> synth-passes path end to end at the generator level.
  expect(output).toMatch(
    /public resetSecondarySecretKeyWo\(\) \{\n\s*this\._secondarySecretKeyWo = undefined;\n\s*\}/,
  );
  expect(output).toMatch(
    /secondary_secret_key_wo: this\.markWriteOnlyAttribute\(cdktn\.stringToTerraform\(this\._secondarySecretKeyWo\)\),/,
  );

  // The non-write-only sibling attribute is untouched: its getter is
  // emitted directly (no @deprecated JSDoc immediately above), its setter
  // has no registration call, and its synthesis isn't wrapped.
  expect(output).toMatch(
    /private _secretKeyWoVersion\?: number; \n\s*public get secretKeyWoVersion\(\)/,
  );
  expect(output).toMatch(
    /public set secretKeyWoVersion\(value: number\) \{\n\s*this\._secretKeyWoVersion = value;\n\s*\}/,
  );
  expect(output).toMatch(
    /secret_key_wo_version: cdktn\.numberToTerraform\(this\._secretKeyWoVersion\),/,
  );
});
