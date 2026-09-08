# Ship a Node.js Lambda

This example deploys a TypeScript handler with one `NodejsFunction` construct. Its Rolldown bundle, ZIP, code hash, role and log group are created automatically.

From the repository root, build the first-party packages:

```sh
pnpm exec nx run-many -t build -p @cdktn/aws-lambda-nodejs cdktn-cli
cd examples/typescript/aws-nodejs-function
pnpm run synth
```

To deploy into your configured AWS account in `eu-central-1`, run `pnpm run deploy`. Use `cdktn destroy` to remove the example's resources afterwards. To run the app directly, use `node main.ts` on Node.js 22.18 or newer.

[`main.ts`](main.ts) contains the infrastructure and [`src/hello.ts`](src/hello.ts) is the deployed handler. See the [package guide](../../../packages/@cdktn/aws-lambda-nodejs/README.md) for runtime settings, permissions, existing roles, VPC support and bundling options.
