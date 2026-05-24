// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import execa from "execa";
import { readSchema } from "@cdktn/provider-schema";
import {
  TerraformProviderConstraint,
  TerraformModuleConstraint,
} from "@cdktn/commons";

const cdktnBin = path.join(__dirname, "../../../cdktn-cli/bundle/bin/cdktn");
const cdktnDist = path.join(__dirname, "../../../../dist");

const includeSynthTests = Boolean(process.env.CI);

enum ProviderType {
  provider,
  module,
}

type ProviderDefinition = {
  fqn: string;
  type: ProviderType;
  path: string;
};

const bindings: Record<string, ProviderDefinition> = {
  aws: {
    fqn: "hashicorp/aws@=5.11.0",
    type: ProviderType.provider,
    path: "providers/aws",
  },
  docker: {
    fqn: "kreuzwerker/docker@=3.0.1",
    type: ProviderType.provider,
    path: "providers/docker",
  },
  null: {
    fqn: "hashicorp/null@=3.2.1",
    type: ProviderType.provider,
    path: "providers/null",
  },
  google: {
    fqn: "hashicorp/google@=4.55.0",
    type: ProviderType.provider,
    path: "providers/google",
  },
  azuread: {
    fqn: "hashicorp/azuread@=2.36.0",
    type: ProviderType.provider,
    path: "providers/azuread",
  },
  local: {
    fqn: "hashicorp/local@=2.3.0",
    type: ProviderType.provider,
    path: "providers/local",
  },
  auth0: {
    fqn: "alexkappa/auth0@=0.26.2",
    type: ProviderType.provider,
    path: "providers/auth0",
  },
  datadog: {
    fqn: "DataDog/datadog@=3.21.0",
    type: ProviderType.provider,
    path: "providers/datadog",
  },
  kubernetes: {
    fqn: "hashicorp/kubernetes@=2.18.0",
    type: ProviderType.provider,
    path: "providers/kubernetes",
  },
  scaleway: {
    fqn: "scaleway/scaleway@ ~>2.10.0",
    type: ProviderType.provider,
    path: "providers/scaleway",
  },
  external: {
    fqn: "hashicorp/external@=2.3.1",
    type: ProviderType.provider,
    path: "providers/external",
  },
  awsVpc: {
    fqn: "terraform-aws-modules/vpc/aws@=3.19.0",
    type: ProviderType.module,
    path: "modules/terraform-aws-modules/aws",
  },
};

/**
 * Generates TypeScript bindings for one provider or module by running `cdktn get` in a fresh temp dir under
 * `parentDir`, and returns the absolute path to the generated `.gen/<binding.path>` subtree. The temp dir lives under
 * `parentDir` (the fixtures root) so `globalTeardown` reclaims it along with the rest of the fixtures.
 *
 * @param binding The provider or module to generate bindings for (fqn, type, path inside `.gen`).
 * @param parentDir Parent directory under which the per-binding temp dir is created — pass `fixturesDir` so cleanup
 *   happens via `globalTeardown`.
 * @returns Absolute path to the generated binding root (i.e. `<tempDir>/.gen/<binding.path>`).
 */
async function generateBinding(
  binding: ProviderDefinition,
  parentDir: string,
): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(parentDir, "cdktf-provider-"));
  await fs.writeFile(
    path.resolve(tempDir, "cdktf.json"),
    JSON.stringify({
      language: "typescript",
      app: "npx ts-node main.ts",
      terraformProviders:
        binding.type === ProviderType.provider ? [binding.fqn] : [],
      terraformModules:
        binding.type === ProviderType.module ? [binding.fqn] : [],
    }),
  );
  await execa(cdktnBin, ["get"], { cwd: tempDir });

  return path.resolve(tempDir, ".gen", binding.path);
}

/**
 * Initialises a fresh CDKTN project for the given language by running `cdktn init --local --template=<language>` in a
 * new temp dir under `parentDir`, and returns the absolute path to that project. The project is treated as a read-only
 * base — each test gets its own provisioned copy via `copyBaseProject` (which symlinks the heavy `node_modules`).
 *
 * @param language Template to initialise (e.g. `typescript`, `python`, `csharp`).
 * @param parentDir Parent directory under which the per-language temp project dir is created — pass `fixturesDir` so
 *   cleanup happens via `globalTeardown`.
 * @returns Absolute path to the initialised base project.
 */
async function prepareBaseProject(
  language: string,
  parentDir: string,
): Promise<string> {
  const projectDir = await fs.mkdtemp(
    path.join(parentDir, "cdktf-convert-base-"),
  );
  await execa(
    cdktnBin,
    [
      "init",
      "--local",
      `--dist=${cdktnDist}`,
      "--project-name='hello'",
      "--project-description='world'",
      `--template=${language}`,
      "--enable-crash-reporting=false",
    ],
    {
      cwd: projectDir,
    },
  );
  return projectDir;
}

export interface FixturesManifest {
  providerBindings: Record<string, string>; // fqn -> absolute path to generated binding dir
  baseProjects: Record<string, string>; // language -> absolute path to base project dir
  schemaCacheDir: string; // absolute path to pre-populated provider schema cache
}

module.exports = async function globalSetup() {
  const fixturesDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "hcl2cdk-fixtures-"),
  );

  console.log("[globalSetup] Generating provider bindings...");
  const bindingEntries = Object.values(bindings);
  const bindingResults = await Promise.all(
    bindingEntries.map(async (b) => {
      const absolutePath = await generateBinding(b, fixturesDir);
      return [b.fqn, absolutePath] as [string, string];
    }),
  );
  const providerBindings = Object.fromEntries(bindingResults);

  const requiredLanguages = includeSynthTests
    ? ["typescript", "python", "csharp"]
    : ["typescript"];

  console.log(
    `[globalSetup] Initializing base projects for: ${requiredLanguages.join(", ")}...`,
  );
  const baseProjectEntries = await Promise.all(
    requiredLanguages.map(async (lang) => {
      const projectDir = await prepareBaseProject(lang, fixturesDir);
      return [lang, projectDir] as [string, string];
    }),
  );
  const baseProjects = Object.fromEntries(baseProjectEntries);

  // Pre-cache provider schemas so test workers never need to run terraform
  const schemaCacheDir = path.join(fixturesDir, "schema-cache");
  await fs.mkdirp(schemaCacheDir);

  console.log("[globalSetup] Pre-caching provider schemas...");
  await Promise.all(
    bindingEntries.map(async (entry) => {
      const constraint =
        entry.type === ProviderType.provider
          ? new TerraformProviderConstraint(entry.fqn)
          : new TerraformModuleConstraint(entry.fqn);
      await readSchema([constraint], schemaCacheDir);
    }),
  );

  const manifest: FixturesManifest = {
    providerBindings,
    baseProjects,
    schemaCacheDir,
  };
  const manifestPath = path.join(fixturesDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // Pass to test workers via environment variables
  // (Jest 29 propagates parent env to forked workers)
  process.env.HCL2CDK_FIXTURES_MANIFEST = manifestPath;
  process.env.CDKTF_EXPERIMENTAL_PROVIDER_SCHEMA_CACHE_PATH = schemaCacheDir;
  process.env.HCL2CDK_FIXTURES_DIR = fixturesDir;

  console.log(`[globalSetup] Fixtures manifest written to ${manifestPath}`);
};
