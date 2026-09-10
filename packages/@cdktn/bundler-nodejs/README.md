# Native Node.js bundles and assets

`NodejsBundler` bundles TypeScript or JavaScript with Rolldown and produces a deterministic ZIP without requiring an app, stack, provider or staging lifecycle.

```ts
import { NodejsBundler } from "@cdktn/bundler-nodejs";

const bundle = new NodejsBundler().bundle({
  entry: "src/handler.ts",
  projectRoot: process.cwd(),
  target: "node24",
});

// bundle.archive contains the deployment ZIP.
// bundle.handler, assetHash and sourceCodeHash describe the exact ZIP bytes.
```

`NodejsAsset` is the CDK Terrain adapter that stages the result through the existing `TerraformAsset` API.

```ts
import { NodejsAsset } from "@cdktn/bundler-nodejs";

const code = new NodejsAsset(stack, "Code", {
  entry: "src/handler.ts",
  target: "node24",
});

// Inputs for an existing Lambda resource:
// filename: code.path
// handler: code.handler
// sourceCodeHash: code.sourceCodeHash
```

For automatic Lambda, IAM and logging setup, use [`NodejsFunction`](../aws-lambda-nodejs/README.md). That guide also documents bundling options, path resolution, reproducibility, plugin configuration, platform requirements and native dependency boundaries.

`bundling.keepNames` preserves function and class names. `bundling.moduleTypes` exposes Rolldown's native loaders, and `bundling.rolldownOptions` exposes its built-in resolution, transform, tree-shaking and output options as typed JSON data. Use `bundling.configFile` for plugins, callbacks and regular expressions. Build options must be concrete during synthesis; unresolved Terraform tokens are rejected.

`compressedSize` is the ZIP's size in bytes; `uncompressedSize` counts all entries, including source maps, emitted assets and copied files. These sizes are read without extracting the archive. `NodejsFunction` enforces Lambda's upload limits; the reusable `NodejsAsset` does not impose AWS-specific limits.

This package uses Rolldown's platform-specific native Rust bindings distributed through npm; it requires no Rust compiler or global bundler installation. Keep optional npm dependencies enabled so the correct binding is installed for the synthesis host. No bundler or build dependencies are included in deployment ZIPs unless the handler itself imports them.
