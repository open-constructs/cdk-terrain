// Copyright (c) OpenConstructs
// SPDX-License-Identifier: MPL-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  App,
  TerraformStack,
  TerraformOutput,
  TerraformVariable,
  Testing,
} from "cdktn";
import { AwsProvider } from "@cdktn/provider-aws/lib/provider/index.js";
import { CloudwatchLogGroup } from "@cdktn/provider-aws/lib/cloudwatch-log-group/index.js";
import { NodejsFunction, NodejsFunctionProps } from "../src";

let root: string;
let app: App;
let stack: TerraformStack;
let props: NodejsFunctionProps;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-lambda-"));
  const entry = path.join(root, "handler.ts");
  fs.writeFileSync(
    entry,
    'export async function handler() { return "hello"; }',
  );
  props = { entry };
  app = new App({ outdir: path.join(root, "out") });
  stack = new TerraformStack(app, "test");
  new AwsProvider(stack, "aws", { region: "eu-central-1" });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function resource(config: any, type: string): any {
  return Object.values(config.resource[type])[0];
}

test("entry alone creates a deployable function, scoped role, log group and matching ZIP hash", () => {
  const fn = new NodejsFunction(stack, "hello", props);
  new TerraformOutput(stack, "arn", { value: fn.arn });
  app.synth();
  const stackDirectory = path.join(app.outdir, "stacks/test");
  const config = JSON.parse(
    fs.readFileSync(path.join(stackDirectory, "cdk.tf.json"), "utf8"),
  );
  const lambda = resource(config, "aws_lambda_function");
  const log = resource(config, "aws_cloudwatch_log_group");
  const policy = resource(config, "aws_iam_role_policy");
  expect(Object.keys(config.resource).sort()).toEqual([
    "aws_cloudwatch_log_group",
    "aws_iam_role",
    "aws_iam_role_policy",
    "aws_lambda_function",
  ]);
  expect(lambda).toMatchObject({
    runtime: "nodejs24.x",
    architectures: ["arm64"],
    memory_size: 512,
    timeout: 10,
    package_type: "Zip",
    handler: "index.handler",
    logging_config: {
      log_format: "JSON",
    },
  });
  expect(lambda.function_name).toMatch(/^test-hello-[a-f0-9]{8}$/);
  expect(log).toMatchObject({
    name: `/aws/lambda/${lambda.function_name}`,
    retention_in_days: 30,
  });
  expect(lambda.environment.variables.NODE_OPTIONS).toBe(
    "--enable-source-maps",
  );
  expect(policy.policy).toContain("logs:CreateLogStream");
  expect(policy.policy).toContain("logs:PutLogEvents");
  expect(policy.policy).not.toContain("logs:CreateLogGroup");
  expect(policy.policy).toContain("aws_cloudwatch_log_group");
  expect(lambda.depends_on.join(" ")).toContain("aws_iam_role_policy");
  expect(lambda.depends_on.join(" ")).toContain("aws_cloudwatch_log_group");
  expect(lambda.depends_on).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^aws_iam_role_policy\.[\w]+$/),
      expect.stringMatching(/^aws_cloudwatch_log_group\.[\w]+$/),
    ]),
  );
  expect(config.output.arn.value).toContain("aws_lambda_function");
  const archive = fs.readFileSync(path.join(stackDirectory, lambda.filename));
  expect(lambda.source_code_hash).toBe(
    createHash("sha256").update(archive).digest("base64"),
  );
});

test("preserves Lambda options and propagates provider aliases to all owned resources", () => {
  const provider = new AwsProvider(stack, "other", {
    alias: "other",
    region: "us-west-2",
  });
  const fn = new NodejsFunction(stack, "hello", {
    ...props,
    provider,
    region: "eu-west-1",
    runtime: "nodejs22.x",
    architectures: ["x86_64"],
    memorySize: 1024,
    timeout: 30,
    publish: true,
    reservedConcurrentExecutions: 4,
    tags: { app: "hello" },
    environment: { MESSAGE: "hello", NODE_OPTIONS: "--stack-trace-limit=50" },
    lifecycle: { preventDestroy: true },
    logRetentionDays: 7,
  });
  fn.addEnvironment("ADDED", "value");
  fn.addToRolePolicy({
    actions: ["s3:GetObject"],
    resources: ["arn:aws:s3:::example/*"],
  });
  const config = JSON.parse(Testing.synth(stack));
  const lambda = resource(config, "aws_lambda_function");
  expect(lambda).toMatchObject({
    runtime: "nodejs22.x",
    architectures: ["x86_64"],
    memory_size: 1024,
    timeout: 30,
    publish: true,
    reserved_concurrent_executions: 4,
    lifecycle: { prevent_destroy: true },
  });
  expect(lambda.environment.variables).toEqual({
    MESSAGE: "hello",
    NODE_OPTIONS: "--stack-trace-limit=50 --enable-source-maps",
    ADDED: "value",
  });
  for (const resources of Object.values(config.resource) as any[]) {
    for (const value of Object.values(resources) as any[])
      expect(value.provider).toBe("aws.other");
  }
  expect(resource(config, "aws_cloudwatch_log_group")).toMatchObject({
    region: "eu-west-1",
    retention_in_days: 7,
  });
  expect(resource(config, "aws_iam_role_policy").policy).toContain(
    "s3:GetObject",
  );
});

test("supports existing execution roles and log groups", () => {
  const logGroup = new CloudwatchLogGroup(stack, "existingLog", {
    name: "/custom/logs",
  });
  const fn = new NodejsFunction(stack, "hello", {
    ...props,
    role: "arn:aws:iam::123456789012:role/existing",
    logGroup,
    bundling: { sourceMap: false },
    loggingConfig: { logFormat: "Text" },
  });
  const config = JSON.parse(Testing.synth(stack));
  const lambda = resource(config, "aws_lambda_function");
  expect(config.resource.aws_iam_role).toBeUndefined();
  expect(config.resource.aws_iam_role_policy).toBeUndefined();
  expect(lambda.role).toBe("arn:aws:iam::123456789012:role/existing");
  expect(lambda.environment).toBeUndefined();
  expect(lambda.logging_config.log_format).toBe("Text");
  expect(Object.keys(config.resource.aws_cloudwatch_log_group)).toHaveLength(1);
  expect(fn.executionRole).toBeUndefined();
  expect(() =>
    fn.addToRolePolicy({ actions: ["s3:GetObject"], resources: ["*"] }),
  ).toThrow(/existing role/);
});

test("adds network-interface permissions when attaching to a VPC", () => {
  new NodejsFunction(stack, "hello", {
    ...props,
    vpcConfig: { subnetIds: ["subnet-123"], securityGroupIds: ["sg-123"] },
    initialPolicy: [
      {
        actions: ["dynamodb:GetItem"],
        resources: ["arn:aws:dynamodb:eu-central-1:123456789012:table/example"],
      },
    ],
  });
  const policy = resource(
    JSON.parse(Testing.synth(stack)),
    "aws_iam_role_policy",
  ).policy;
  expect(policy).toContain("ec2:CreateNetworkInterface");
  expect(policy).toContain("ec2:DescribeSubnets");
  expect(policy).toContain("dynamodb:GetItem");
});

test("runtime variables change configuration without changing the code digest", () => {
  const first = new NodejsFunction(stack, "first", {
    ...props,
    environment: { VALUE: "one" },
  });
  const second = new NodejsFunction(stack, "second", {
    ...props,
    environment: { VALUE: "two" },
  });
  expect(first.code.sourceCodeHash).toBe(second.code.sourceCodeHash);
});

test("deployment-time values remain valid in runtime environment variables", () => {
  const url = new TerraformVariable(stack, "api_url", { type: "string" })
    .stringValue;
  const fn = new NodejsFunction(stack, "runtime", {
    ...props,
    environment: { API_URL: url },
    bundling: {
      keepNames: true,
      moduleTypes: { ".sql": "text" },
      rolldownOptions: { output: { sourcemapExcludeSources: true } },
    },
  });
  fn.addEnvironment("SECOND_URL", url);
  const lambda = resource(
    JSON.parse(Testing.synth(stack)),
    "aws_lambda_function",
  );
  expect(lambda.environment.variables.API_URL).toBe("${var.api_url}");
  expect(lambda.environment.variables.SECOND_URL).toBe("${var.api_url}");
  expect(
    () =>
      new NodejsFunction(stack, "build", {
        ...props,
        bundling: { define: { API_URL: JSON.stringify(url) } },
      }),
  ).toThrow(/NodejsFunction.environment/);
});

test("validates options which cannot produce a Node.js function", () => {
  expect(
    () => new NodejsFunction(stack, "bad", { ...props, runtime: "python3.14" }),
  ).toThrow(/Node.js runtime/);
  expect(
    () =>
      new NodejsFunction(stack, "badrole", {
        ...props,
        role: "existing",
        initialPolicy: [{ actions: ["s3:GetObject"], resources: ["*"] }],
      }),
  ).toThrow(/initialPolicy/);
});
