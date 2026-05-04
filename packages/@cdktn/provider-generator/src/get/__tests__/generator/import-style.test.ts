// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CodeMaker } from "codemaker";
import {
  TerraformProviderGenerator,
  type TerraformProviderGeneratorOptions,
} from "../../generator/provider-generator";

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "aws_wafv2_web_acl.test.fixture.json"),
    "utf-8",
  ),
);

async function generate(options: TerraformProviderGeneratorOptions = {}) {
  const code = new CodeMaker();
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "import-style.test"));
  new TerraformProviderGenerator(code, fixture, options).generateAll();
  await code.save(workdir);
  return workdir;
}

const RESOURCE_INDEX = "providers/test/wafv2-web-acl/index.ts";
const STRUCTS_INDEX = "providers/test/wafv2-web-acl/index-structs/index.ts";
const STRUCTS_DIR = "providers/test/wafv2-web-acl/index-structs";
const PROVIDER_INDEX = "providers/test/index.ts";

function readAllShards(workdir: string): string {
  return fs
    .readdirSync(path.join(workdir, STRUCTS_DIR))
    .filter((f) => /^structs\d+\.ts$/.test(f))
    .map((f) => fs.readFileSync(path.join(workdir, STRUCTS_DIR, f), "utf-8"))
    .join("\n");
}

test("default (no importExtension): emits explicit /index for folders, bare for files", async () => {
  const workdir = await generate();

  const resource = fs.readFileSync(path.join(workdir, RESOURCE_INDEX), "utf-8");
  expect(resource).toContain(`} from './index-structs/index'`);
  expect(resource).toContain(`export * from './index-structs/index'`);
  expect(resource).not.toMatch(/from '\.\/[^']*\.(js|ts)'/);

  const structsIndex = fs.readFileSync(
    path.join(workdir, STRUCTS_INDEX),
    "utf-8",
  );
  expect(structsIndex).toContain(`export * from './structs0'`);
  expect(structsIndex).not.toMatch(/from '\.\/[^']*\.(js|ts)'/);

  const providerIndex = fs.readFileSync(
    path.join(workdir, PROVIDER_INDEX),
    "utf-8",
  );
  expect(providerIndex).toMatch(/from '\.\/[^']+\/index';/);
});

test("importExtension '.js': emits fully-qualified ./<folder>/index.js and ./<file>.js", async () => {
  const workdir = await generate({ importExtension: ".js" });

  const resource = fs.readFileSync(path.join(workdir, RESOURCE_INDEX), "utf-8");
  expect(resource).toContain(`} from './index-structs/index.js'`);
  expect(resource).toContain(`export * from './index-structs/index.js'`);

  const structsIndex = fs.readFileSync(
    path.join(workdir, STRUCTS_INDEX),
    "utf-8",
  );
  expect(structsIndex).toContain(`export * from './structs0.js'`);

  const allShards = readAllShards(workdir);
  expect(allShards).toMatch(/from '\.\/structs\d+\.js'/);

  const providerIndex = fs.readFileSync(
    path.join(workdir, PROVIDER_INDEX),
    "utf-8",
  );
  expect(providerIndex).toMatch(/from '\.\/[^']+\/index\.js';/);
});

test("importExtension '.ts': emits fully-qualified ./<folder>/index.ts and ./<file>.ts", async () => {
  const workdir = await generate({ importExtension: ".ts" });

  const resource = fs.readFileSync(path.join(workdir, RESOURCE_INDEX), "utf-8");
  expect(resource).toContain(`} from './index-structs/index.ts'`);
  expect(resource).toContain(`export * from './index-structs/index.ts'`);

  const structsIndex = fs.readFileSync(
    path.join(workdir, STRUCTS_INDEX),
    "utf-8",
  );
  expect(structsIndex).toContain(`export * from './structs0.ts'`);

  const allShards = readAllShards(workdir);
  expect(allShards).toMatch(/from '\.\/structs\d+\.ts'/);

  const providerIndex = fs.readFileSync(
    path.join(workdir, PROVIDER_INDEX),
    "utf-8",
  );
  expect(providerIndex).toMatch(/from '\.\/[^']+\/index\.ts';/);
});

test("importExtension '': emits explicit /index for folders, bare for files", async () => {
  const workdir = await generate({ importExtension: "" });

  const resource = fs.readFileSync(path.join(workdir, RESOURCE_INDEX), "utf-8");
  expect(resource).toContain(`} from './index-structs/index'`);
  expect(resource).toContain(`export * from './index-structs/index'`);
  expect(resource).not.toMatch(/from '\.\/[^']*\.(js|ts)'/);

  const structsIndex = fs.readFileSync(
    path.join(workdir, STRUCTS_INDEX),
    "utf-8",
  );
  // file targets get the (empty) extension, so they stay bare
  expect(structsIndex).toContain(`export * from './structs0'`);
  expect(structsIndex).not.toMatch(/from '\.\/[^']*\.(js|ts)'/);

  const providerIndex = fs.readFileSync(
    path.join(workdir, PROVIDER_INDEX),
    "utf-8",
  );
  expect(providerIndex).toMatch(/from '\.\/[^']+\/index';/);
});
