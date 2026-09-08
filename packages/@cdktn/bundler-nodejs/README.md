# Native Node.js bundle assets

`NodejsAsset` bundles TypeScript or JavaScript with Rolldown and produces a deterministic ZIP through CDK Terrain's `TerraformAsset` staging API.

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

This package uses Rolldown's platform-specific native Rust bindings distributed through npm; it requires no Rust compiler or global bundler installation. Keep optional npm dependencies enabled so the correct binding is installed for the synthesis host. No bundler or build dependencies are included in deployment ZIPs unless the handler itself imports them.
