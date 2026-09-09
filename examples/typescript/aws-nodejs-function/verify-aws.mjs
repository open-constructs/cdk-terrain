// Copyright (c) OpenConstructs
// SPDX-License-Identifier: MPL-2.0
// Opt-in deployment test. All resources belong to a unique, temporary stack.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout } from "node:timers/promises";

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    region: { type: "string", default: "eu-central-1" },
    "synth-only": { type: "boolean", default: false },
  },
});
assert(
  values.profile || values["synth-only"],
  "Supply --profile for AWS validation",
);
const example = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-nodejs-aws-"));
const stackId = `native-nodejs-${randomUUID().slice(0, 8)}`;
const stackDirectory = path.join(root, "cdktf.out/stacks", stackId);
const terraform = process.env.TERRAFORM_BINARY_NAME ?? "terraform";
const env = {
  ...process.env,
  AWS_PROFILE: values.profile,
  AWS_REGION: values.region,
  AWS_PAGER: "",
  TF_IN_AUTOMATION: "true",
  CHECKPOINT_DISABLE: "1",
};
// The explicit profile must select both the CLI and provider credentials.
for (const key of [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_DEFAULT_PROFILE",
])
  delete env[key];
let commandNumber = 0;
let attemptedApply = false;
let config;
const summary = { region: values.region, checks: [], cleanup: false };

function write(file, value) {
  fs.writeFileSync(path.join(root, file), value);
}

function run(command, args, { cwd = root, statuses = [0] } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const evidence = `${String(++commandNumber).padStart(3, "0")}.json`;
  write(
    evidence,
    JSON.stringify(
      {
        command,
        args,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error?.message,
      },
      null,
      2,
    ),
  );
  assert(
    statuses.includes(result.status),
    `Command failed: ${command} ${args[0]}; inspect ${path.join(root, evidence)}`,
  );
  return result;
}

function tf(...args) {
  return run(terraform, args, { cwd: stackDirectory }).stdout;
}

function aws(...args) {
  return run("aws", [
    "--profile",
    values.profile,
    "--region",
    values.region,
    "--output",
    "json",
    ...args,
  ]);
}

function awsJson(...args) {
  return JSON.parse(aws(...args).stdout);
}

function passed(check) {
  summary.checks.push(check);
  console.log(`PASS ${check}`);
  write("summary.json", JSON.stringify(summary, null, 2));
}

function synth() {
  run(process.execPath, ["main.mjs"]);
  config = JSON.parse(
    fs.readFileSync(path.join(stackDirectory, "cdk.tf.json"), "utf8"),
  );
  for (const fn of Object.values(config.resource.aws_lambda_function)) {
    const archive = fs.readFileSync(path.join(stackDirectory, fn.filename));
    assert.equal(
      createHash("sha256").update(archive).digest("base64"),
      fn.source_code_hash,
    );
  }
}

function plan(name, expectedAction, count) {
  tf("plan", "-input=false", "-no-color", `-out=${name}.tfplan`);
  const plan = JSON.parse(tf("show", "-json", `${name}.tfplan`));
  const changes = plan.resource_changes.filter(
    (resource) => resource.change.actions.join() !== "no-op",
  );
  assert.equal(changes.length, count);
  for (const resource of changes) {
    assert.deepEqual(resource.change.actions, [expectedAction]);
    assert(
      [
        "aws_lambda_function",
        "aws_iam_role",
        "aws_iam_role_policy",
        "aws_cloudwatch_log_group",
      ].includes(resource.type),
    );
    if (expectedAction === "update")
      assert.equal(resource.type, "aws_lambda_function");
  }
  return changes;
}

function noChanges() {
  tf("plan", "-input=false", "-no-color", "-detailed-exitcode");
}

function invoke(name, event) {
  const output = path.join(root, `invoke-${commandNumber}.json`);
  const metadata = awsJson(
    "lambda",
    "invoke",
    "--function-name",
    name,
    "--cli-binary-format",
    "raw-in-base64-out",
    "--payload",
    JSON.stringify(event),
    "--log-type",
    "Tail",
    output,
  );
  assert.equal(metadata.StatusCode, 200);
  return { metadata, response: JSON.parse(fs.readFileSync(output, "utf8")) };
}

function verifyFunctions(version) {
  const outputs = JSON.parse(tf("output", "-json"));
  for (const kind of ["hello", "esm", "cjs"]) {
    const fn = outputs[kind].value;
    const deployed = awsJson(
      "lambda",
      "get-function-configuration",
      "--function-name",
      fn.name,
    );
    assert.equal(deployed.State, "Active");
    assert.equal(deployed.LastUpdateStatus, "Successful");
    assert.equal(deployed.Runtime, "nodejs24.x");
    assert.deepEqual(deployed.Architectures, [
      kind === "cjs" ? "x86_64" : "arm64",
    ]);
    assert.equal(deployed.MemorySize, 512);
    assert.equal(deployed.Timeout, 10);
    assert.equal(deployed.LoggingConfig.LogFormat, "JSON");
    assert.equal(deployed.LoggingConfig.LogGroup, fn.logGroup);
    assert.equal(deployed.CodeSha256, fn.hash);
    assert.equal(
      deployed.Environment.Variables.NODE_OPTIONS,
      "--enable-source-maps",
    );
    const { metadata, response } = invoke(fn.name, {
      name: "AWS",
      token: `${stackId}-${version}-${kind}`,
    });
    assert.equal(metadata.FunctionError, undefined, JSON.stringify(response));
    if (kind === "hello") {
      assert.deepEqual(response, { message: "Hello from CDK Terrain, AWS!" });
    } else {
      assert.deepEqual(response, {
        version,
        greeting: "Hello from CDK Terrain",
        added: "extra",
        legacy: "COMMONJS",
        copied: "copied asset",
        alias: "typescript alias",
        lazy: "lazy import",
        lazyBefore: false,
        architecture: kind === "cjs" ? "x64" : "arm64",
        node: 24,
      });
      assert(
        Buffer.from(metadata.LogResult, "base64")
          .toString()
          .includes("native-nodejs-validation"),
      );
    }
    passed(
      `${version}: ${kind} invocation, configuration and deployed ZIP hash`,
    );
  }
  return outputs;
}

async function verifyLogs(outputs) {
  for (const kind of ["esm", "cjs"]) {
    const fn = outputs[kind].value;
    const groups = awsJson(
      "logs",
      "describe-log-groups",
      "--log-group-name-prefix",
      fn.logGroup,
    ).logGroups;
    assert.equal(
      groups.find((group) => group.logGroupName === fn.logGroup)
        ?.retentionInDays,
      30,
    );
    let events = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      events = awsJson(
        "logs",
        "filter-log-events",
        "--log-group-name",
        fn.logGroup,
        "--filter-pattern",
        '"native-nodejs-validation"',
      ).events;
      if (events.length) break;
      await setTimeout(5000);
    }
    assert(events.length > 0, `No CloudWatch application logs for ${kind}`);
    assert(events.some((event) => JSON.parse(event.message).level === "INFO"));
    const failure = invoke(fn.name, { fail: true });
    assert.equal(failure.metadata.FunctionError, "Unhandled");
    assert.equal(failure.response.errorMessage, "source-map-check");
    assert(
      failure.response.trace.some((frame) => /common\.ts:\d+:\d+/.test(frame)),
      JSON.stringify(failure.response),
    );
    passed(
      `${kind}: scoped logging permissions, JSON CloudWatch logs, retention and TypeScript error source maps`,
    );
  }
}

async function verifyAbsent() {
  for (const fn of Object.values(config.resource.aws_lambda_function)) {
    const result = run(
      "aws",
      [
        "--profile",
        values.profile,
        "--region",
        values.region,
        "lambda",
        "get-function",
        "--function-name",
        fn.function_name,
      ],
      { statuses: [254] },
    );
    assert(result.stderr.includes("ResourceNotFoundException"));
  }
  for (const log of Object.values(config.resource.aws_cloudwatch_log_group)) {
    const groups = awsJson(
      "logs",
      "describe-log-groups",
      "--log-group-name-prefix",
      log.name,
    ).logGroups;
    assert(!groups.some((group) => group.logGroupName === log.name));
  }
  const roles = awsJson("iam", "list-roles").Roles;
  for (const role of Object.values(config.resource.aws_iam_role))
    assert(
      !roles.some((existing) => existing.RoleName.startsWith(role.name_prefix)),
    );
  assert.equal(tf("state", "list").trim(), "");
  summary.cleanup = true;
  passed(
    "cleanup: empty Terraform state and independent Lambda, log group and IAM absence checks",
  );
}

console.log(`Evidence and recovery state: ${root}`);
fs.symlinkSync(
  path.join(example, "node_modules"),
  path.join(root, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);
write("hello.ts", fs.readFileSync(path.join(example, "src/hello.ts")));
write("version.ts", 'export const version = "v1";\n');
write("settings.ts", 'export const alias = "typescript alias";\n');
write("legacy.cjs", "module.exports = (value) => value.toUpperCase();\n");
write(
  "lazy.ts",
  'globalThis.__nativeNodejsLazy = true; export const lazy = "lazy import";\n',
);
write("message.txt", "copied asset\n");
write(
  "tsconfig.json",
  JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } },
  }),
);
write(
  "common.ts",
  `import { readFileSync } from "node:fs";
import { join } from "node:path";
import { version } from "./version";
import { alias } from "@/settings";
import legacy from "./legacy.cjs";
export async function run(event) {
  if (event.fail) throw new Error("source-map-check");
  const lazyBefore = globalThis.__nativeNodejsLazy ?? false;
  const { lazy } = await import("./lazy");
  console.log("native-nodejs-validation", { token: event.token, version });
  return {
    version, alias, lazy, lazyBefore,
    greeting: process.env.GREETING,
    added: process.env.ADDED,
    legacy: legacy("commonjs"),
    copied: readFileSync(join(process.env.LAMBDA_TASK_ROOT, "message.txt"), "utf8").trim(),
    architecture: process.arch,
    node: Number(process.versions.node.split(".")[0]),
  };
}
`,
);
write(
  "esm.ts",
  'import { run as handler } from "./common"; export const run = await Promise.resolve(handler);\n',
);
const account = values["synth-only"]
  ? undefined
  : awsJson("sts", "get-caller-identity").Account;
write(
  "main.mjs",
  `import { App, LocalBackend, TerraformStack, TerraformOutput } from "cdktn";
import { AwsProvider } from "@cdktn/provider-aws/lib/provider/index.js";
import { NodejsFunction } from "@cdktn/aws-lambda-nodejs";
const app = new App({ outdir: ${JSON.stringify(path.join(root, "cdktf.out"))} });
const stack = new TerraformStack(app, ${JSON.stringify(stackId)});
new LocalBackend(stack, { path: ${JSON.stringify(path.join(root, "terraform.tfstate"))} });
new AwsProvider(stack, "aws", ${JSON.stringify({ region: values.region, profile: values.profile, allowedAccountIds: account ? [account] : undefined })});
for (const kind of ["hello", "esm", "cjs"]) {
  const fn = new NodejsFunction(stack, kind + "Function", {
    entry: kind === "hello" ? "hello.ts" : kind === "esm" ? "esm.ts" : "common.ts",
    environment: { GREETING: "Hello from CDK Terrain" },
    ...(kind === "hello" ? {} : {
      handler: "run",
      ...(kind === "cjs" ? { architectures: ["x86_64"] } : {}),
      bundling: { format: kind, copyFiles: [{ from: "message.txt", to: "message.txt" }] },
    }),
  });
  if (kind !== "hello") fn.addEnvironment("ADDED", "extra");
  new TerraformOutput(stack, kind, { value: { name: fn.functionName, hash: fn.code.sourceCodeHash, logGroup: fn.logGroup.name } });
}
app.synth();
`,
);

try {
  synth();
  passed(
    "synthesis: example, ESM/top-level await and CommonJS; staged ZIP hashes",
  );
  if (!values["synth-only"]) {
    tf("init", "-input=false", "-no-color");
    tf("validate", "-no-color");
    plan("create", "create", 12);
    console.log(
      "Deploying three temporary Lambda functions and their IAM/log resources",
    );
    attemptedApply = true;
    tf("apply", "-input=false", "-no-color", "create.tfplan");
    const first = verifyFunctions("v1");
    await verifyLogs(first);
    synth();
    noChanges();
    passed("unchanged source: no Terraform changes after a fresh synthesis");
    write("version.ts", 'export const version = "v2";\n');
    synth();
    plan("update", "update", 2);
    tf("apply", "-input=false", "-no-color", "update.tfplan");
    const second = verifyFunctions("v2");
    assert.equal(first.hello.value.hash, second.hello.value.hash);
    for (const kind of ["esm", "cjs"])
      assert.notEqual(first[kind].value.hash, second[kind].value.hash);
    noChanges();
    passed(
      "transitive source update: only two code updates, new deployed hashes/results, no subsequent drift",
    );
  }
} finally {
  if (attemptedApply) {
    console.log("Destroying temporary resources");
    tf("destroy", "-input=false", "-no-color", "-auto-approve");
    await verifyAbsent();
  }
}
console.log(
  values["synth-only"]
    ? "Local synthesis checks passed; no AWS resources created"
    : "AWS validation passed; all test resources removed",
);
