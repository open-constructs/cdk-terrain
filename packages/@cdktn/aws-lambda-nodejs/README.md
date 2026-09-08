# Node.js functions for CDK Terrain

Ship a TypeScript or JavaScript Lambda by pointing at its entry file:

```ts
import { NodejsFunction } from "@cdktn/aws-lambda-nodejs";

const hello = new NodejsFunction(stack, "hello", {
  entry: "src/hello.ts",
});
```

```ts
// src/hello.ts
export async function handler(event: { name?: string }) {
  return { message: `Hello ${event.name ?? "world"}` };
}
```

Run `cdktn deploy`. The construct bundles the handler and its dependencies, creates a deterministic ZIP, stages it in the synthesized stack, and configures the Lambda, execution role, logging permissions, and log group. Terraform uploads the ZIP during apply. There is no packaging provider, prebuild script, asset bucket, or bootstrap step.

## Installation

This feature branch adds two first-party packages: `@cdktn/aws-lambda-nodejs` and the reusable `@cdktn/bundler-nodejs`. They are not published yet. Inside this monorepo, use the [working example](../../../examples/typescript/aws-nodejs-function). Release packaging uses the same workspace version and `dist/js` convention as the other CDKTN packages.

After publication:

```sh
pnpm add @cdktn/aws-lambda-nodejs @cdktn/provider-aws cdktn constructs
```

The packages currently expose TypeScript/JavaScript APIs, including CommonJS and native ESM imports. Node.js 22.12 or newer is required on the synthesis machine. They use the AWS provider's generated classes and require `@cdktn/provider-aws` 25.4 or a compatible 25.x release. Other generated provider classes and their tokens remain usable in the same stack.

## Defaults

| Setting             | Default                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| Runtime             | `nodejs24.x`                                                              |
| Architecture        | `arm64`                                                                   |
| Memory / timeout    | 512 MiB / 10 seconds                                                      |
| Source export       | `handler`                                                                 |
| Bundler             | Rolldown 1.2.7, using its native Rust binding                             |
| Output              | Minified ESM, with lazy dynamic imports preserved                         |
| Dependencies        | Bundled, including installed AWS SDK clients                              |
| Source maps         | Included, with `--enable-source-maps` in `NODE_OPTIONS`                   |
| Log retention       | 30 days                                                                   |
| Log format          | JSON                                                                      |
| Execution role      | Automatically created, with permissions scoped to the log group's streams |
| Deployment identity | SHA-256 of the actual ZIP bytes                                           |

Node.js 24 is the latest stable managed Lambda runtime; Node.js 26 is currently a public preview. The runtime is configurable, and the bundler's syntax target follows it. See [AWS's runtime documentation](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html) and [preview announcement](https://aws.amazon.com/about-aws/whats-new/2026/08/aws-lambda-node-js-python-public-preview/).

## Configure the function

The class name follows AWS CDK's familiar `NodejsFunction` terminology. This is a CDK Terrain implementation over Terraform's generated `LambdaFunction`, with its own props and defaults; the `@cdktn` package scope identifies the framework.

`NodejsFunction` extends the generated `LambdaFunction`. Its outputs, provider support, lifecycle controls, setters, and Terraform overrides remain available. Packaging inputs are owned by the construct. Define multiple functions with ordinary language loops rather than Terraform `count` or `forEach`.

```ts
const worker = new NodejsFunction(stack, "worker", {
  entry: "src/worker.ts",
  handler: "processEvent",
  runtime: "nodejs24.x",
  architectures: ["x86_64"],
  memorySize: 1024,
  timeout: 30,
  environment: { TABLE_NAME: table.name },
  initialPolicy: [
    {
      actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
      resources: [table.arn],
    },
  ],
});

worker.addEnvironment("STAGE", "production");
worker.addToRolePolicy({
  actions: ["s3:GetObject"],
  resources: [`${bucket.arn}/*`],
});

new TerraformOutput(stack, "functionArn", { value: worker.arn });
```

You can supply `role` as an existing execution-role ARN and `logGroup` as a `CloudwatchLogGroup`. Manage permissions on an existing role yourself. A `provider` alias is forwarded to every owned AWS resource; a per-resource `region` is forwarded to the Lambda and log group. Supplying `vpcConfig` adds the [network-interface permissions required by Lambda](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html#configuration-vpc-permissions) to an automatically created role.

## Customize bundling

Relative paths resolve from `projectRoot`, the directory containing `cdktf.json`, or the current directory if there is no configuration file. Rolldown reads the handler's TypeScript configuration, including path aliases. TypeScript is transpiled; run your application's type checker separately.

```ts
new NodejsFunction(stack, "worker", {
  entry: "src/worker.ts",
  bundling: {
    format: "esm", // or "cjs"
    minify: true,
    sourceMap: true,
    tsconfig: "tsconfig.lambda.json",
    define: { "process.env.BUILD_MODE": JSON.stringify("production") },
    copyFiles: [{ from: "templates", to: "templates" }],
    externalModules: ["package-from-my-layer"],
  },
});
```

An external package, including its subpaths, must be supplied by a layer or explicitly copied into `node_modules` in the ZIP. Dependencies are never silently externalized when resolution fails. `copyFiles` rejects traversal, collisions, and symlinks; provide a prepared directory containing real files. Native addons must be built for the selected Lambda architecture and Amazon Linux runtime, then supplied this way or through a layer. Automatic native dependency installation and Docker builds are outside this first implementation.

For Rollup-compatible plugins or advanced Rolldown transforms, supply `bundling.configFile` pointing to a JavaScript configuration module:

```js
// rolldown.lambda.config.mjs
export default {
  plugins: [
    /* Rolldown / compatible Rollup plugins */
  ],
  output: { keepNames: true },
};
```

The construct controls the entry point, Node platform, target, externals, output paths, format, minification and source maps. Other input/output options are passed through. This configuration module runs at synthesis; handler code does not.

## Build and deployment behavior

Bundling happens while constructing the app, because output hashes require the completed artifact. Every construction rebuilds the import graph; there is no source-only cache that can miss a changed dependency, config file or plugin. Unrelated files do not change the digest. ZIP entries have stable ordering, timestamps and permissions, and source maps use relative paths. Intermediate ZIPs live under `cdktf.out/.nodejs-assets`; `TerraformAsset` copies the selected ZIP into the stack's `assets` directory. The entire build output can be removed with the app's output directory.

The synthesized stack contains the complete artifact. Subsequent Terraform plan/apply can consume that stack directory without source files, Rolldown, Node.js, or a separate packaging provider. Preserve the stack's assets when transferring it to a remote runner.

This implementation uses Lambda's direct ZIP upload path and is subject to its [deployment package limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html). S3 publishing for larger artifacts, JSII language bindings, deployment/bootstrap services, and a watch server are not included. It composes with the existing `TerraformAsset` API and does not depend on the pending asset-pipeline PRs ([#380](https://github.com/open-constructs/cdk-terrain/issues/380)).

## Development validation

```sh
pnpm exec nx run-many -t build test lint -p @cdktn/bundler-nodejs @cdktn/aws-lambda-nodejs
pnpm --filter @cdktn/bundler-nodejs run package:js
pnpm --filter @cdktn/aws-lambda-nodejs run package:js
```

Tests run real native builds and invoke extracted ESM/CommonJS handlers. They cover dependency resolution, TypeScript aliases, lazy imports, top-level await, maps, reproducible ZIP identity, plugin/copy inputs, failure diagnostics, provider aliases, IAM dependencies, existing roles, and VPC permissions.
