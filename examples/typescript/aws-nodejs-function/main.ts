// Copyright (c) OpenConstructs
// SPDX-License-Identifier: MPL-2.0
import { App, TerraformOutput, TerraformStack } from "cdktn";
import { AwsProvider } from "@cdktn/provider-aws/lib/provider/index.js";
import { NodejsFunction } from "@cdktn/aws-lambda-nodejs";

const app = new App();
const stack = new TerraformStack(app, "hello");
new AwsProvider(stack, "aws", { region: "eu-central-1" });

const hello = new NodejsFunction(stack, "hello", {
  entry: "src/hello.ts",
  environment: { GREETING: "Hello from CDK Terrain" },
});

new TerraformOutput(stack, "function_name", { value: hello.functionName });
app.synth();
