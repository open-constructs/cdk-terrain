// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as path from "path";
import * as fs from "fs-extra";
import { edgeSchema } from ".";
import { generateProviderBindingsFromSchema } from "../..";

// This script builds the schema for the edge provider into the given directory for all languages.
const args = process.argv.slice(2);
const targetPath = args[0];

if (!targetPath) {
  console.error("No target path specified");
  process.exit(1);
}

// Clear / Create path
fs.mkdirpSync(targetPath);
fs.emptyDirSync(targetPath);

// Static require.resolve calls so knip / pnpm strict isolation can see the deps.
const deps = [
  path.dirname(require.resolve("@types/node/package.json")),
  path.dirname(require.resolve("constructs/package.json")),
  path.dirname(require.resolve("cdktn/package.json")),
];

// Generated sources under `root`, used to check the compat tree really differs.
function tsSources(root: string): string {
  const dir = path.join(root, "providers", "edge");
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

(async () => {
  // The default bindings are the baseline the compat ones are compared with.
  delete process.env.CDKTN_STRUCT_DEDUP_MODE;
  await generateProviderBindingsFromSchema(targetPath, edgeSchema, {
    entrypoint: path.join("providers", "edge", "index.ts"),
    deps,
    moduleKey: "edge",
    python: {
      outdir: path.resolve(targetPath, "python"),
      moduleName: "edge",
    },
    java: {
      outdir: path.resolve(targetPath, "java"),
      package: `imports.edgeprovider`,
    },
    csharp: {
      outdir: path.resolve(targetPath, "csharp"),
      namespace: "Providers.Edge",
    },
    golang: {
      outdir: path.resolve(targetPath, "go"),
      moduleName: "cdk.tf/go/stack/generated/hashicorp",
      packageName: "edge",
    },
  });

  // The same bindings with compatible struct dedup, for the old-name consumer
  // tests in test/{typescript,python,go}/edge.
  const compatPath = path.join(targetPath, "compat");
  process.env.CDKTN_STRUCT_DEDUP_MODE = "compat";
  try {
    await generateProviderBindingsFromSchema(compatPath, edgeSchema, {
      entrypoint: path.join("providers", "edge", "index.ts"),
      deps,
      moduleKey: "edge",
      python: {
        outdir: path.resolve(compatPath, "python"),
        moduleName: "edge",
      },
      golang: {
        outdir: path.resolve(compatPath, "go"),
        moduleName: "cdk.tf/go/stack/generated/hashicorp",
        packageName: "edge",
      },
    });
  } finally {
    delete process.env.CDKTN_STRUCT_DEDUP_MODE;
  }
  if (tsSources(compatPath) === tsSources(targetPath)) {
    throw new Error(
      "compat edge bindings are identical to the default ones; the consumer tests would prove nothing",
    );
  }
})();
