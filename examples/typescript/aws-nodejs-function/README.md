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

## AWS smoke test

After building the packages, run the opt-in deployment test with an AWS profile permitted to manage Lambda functions, IAM execution roles/policies and CloudWatch log groups:

```sh
node verify-aws.mjs --synth-only
node verify-aws.mjs --profile my-test-profile --region eu-central-1
```

The test deploys three uniquely named Node.js 24 functions: this example's handler, an ESM handler with top-level await on ARM64, and a CommonJS handler on x86-64. It verifies deployed ZIP hashes, invocation results, TypeScript aliases, CommonJS dependencies, lazy imports, copied files, environment variables, JSON logs, source maps and log retention. It then checks a fresh synthesis produces no changes, changes a transitive source dependency, verifies that only the two affected functions update, and checks for drift again.

The test uses the AWS CLI and Terraform from `PATH`; `TERRAFORM_BINARY_NAME` can select another Terraform executable. It stores command output and local Terraform state in the temporary directory printed at startup. These files contain account and resource identifiers and should stay private. The test destroys its resources in `finally` and independently checks that the functions, log groups and execution roles are absent. If the process is forcibly interrupted or cleanup fails, use `terraform -chdir=<printed-directory>/cdktf.out/stacks/<stack-id> destroy` with the same AWS profile to resume cleanup.
