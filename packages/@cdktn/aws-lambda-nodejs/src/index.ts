// Copyright (c) OpenConstructs
// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";
import { Construct } from "constructs";
import { dependable, Fn } from "cdktn";
import { NodejsAsset, NodejsBundlingOptions } from "@cdktn/bundler-nodejs";
import {
  LambdaFunction,
  LambdaFunctionConfig,
  LambdaFunctionLoggingConfig,
} from "@cdktn/provider-aws/lib/lambda-function/index.js";
import { IamRole } from "@cdktn/provider-aws/lib/iam-role/index.js";
import { IamRolePolicy } from "@cdktn/provider-aws/lib/iam-role-policy/index.js";
import { CloudwatchLogGroup } from "@cdktn/provider-aws/lib/cloudwatch-log-group/index.js";

export {
  NodejsAsset,
  NodejsAssetProps,
  NodejsBundlingOptions,
  CopyFile,
} from "@cdktn/bundler-nodejs";

/** An execution-role permission, with Terraform tokens supported in values. */
export interface PolicyStatement {
  readonly actions: string[];
  readonly resources: string[];
  readonly effect?: "Allow" | "Deny";
  readonly conditions?: Record<string, Record<string, string | string[]>>;
}

/** Lambda options, with code packaging and execution-role setup handled for you. */
export interface NodejsFunctionProps extends Omit<
  LambdaFunctionConfig,
  | "filename"
  | "imageUri"
  | "s3Bucket"
  | "s3Key"
  | "s3ObjectVersion"
  | "sourceCodeHash"
  | "codeSha256"
  | "packageType"
  | "handler"
  | "role"
  | "functionName"
  | "environment"
  | "loggingConfig"
  | "count"
  | "forEach"
> {
  /** TypeScript or JavaScript source. Relative to projectRoot. */
  readonly entry: string;
  /** Export in the entry file. @default "handler" */
  readonly handler?: string;
  /** @default directory containing cdktf.json, or cwd */
  readonly projectRoot?: string;
  /** @default generated from the construct path */
  readonly functionName?: string;
  /** Existing execution-role ARN. Otherwise a role with scoped logging permissions is created. */
  readonly role?: string;
  readonly environment?: Record<string, string>;
  readonly bundling?: NodejsBundlingOptions;
  /** Permissions to add to the automatically created execution role. */
  readonly initialPolicy?: PolicyStatement[];
  /** Existing log group. Otherwise a log group with 30-day retention is created. */
  readonly logGroup?: CloudwatchLogGroup;
  /** Retention for the created log group; 0 means indefinite. @default 30 */
  readonly logRetentionDays?: number;
  readonly loggingConfig?: Omit<LambdaFunctionLoggingConfig, "logGroup">;
}

/** A Node.js Lambda with native bundling, deterministic code assets, IAM and logs. */
export class NodejsFunction extends LambdaFunction {
  public readonly code: NodejsAsset;
  public readonly executionRole?: IamRole;
  public readonly logGroup: CloudwatchLogGroup;
  private readonly executionPolicy?: IamRolePolicy;
  private readonly statements: PolicyStatement[] = [];

  constructor(scope: Construct, id: string, props: NodejsFunctionProps) {
    const {
      entry,
      handler,
      projectRoot,
      bundling,
      environment,
      initialPolicy,
      logGroup,
      logRetentionDays,
      loggingConfig,
      ...lambda
    } = props;
    const runtime = props.runtime ?? "nodejs24.x";
    const runtimeMatch = /^nodejs(\d+)\.x$/.exec(runtime);
    if (!runtimeMatch)
      throw new Error(
        `NodejsFunction requires a concrete Node.js runtime, received ${runtime}`,
      );
    if (props.role && initialPolicy?.length)
      throw new Error(
        "initialPolicy requires an automatically created execution role. Add permissions to your existing role directly.",
      );

    const functionName = props.functionName ?? uniqueName(scope, id);
    const variables = { ...environment };
    if (bundling?.sourceMap !== false) {
      const options = variables.NODE_OPTIONS ?? "";
      variables.NODE_OPTIONS = options.includes("--enable-source-maps")
        ? options
        : `${options} --enable-source-maps`.trim();
    }
    super(scope, id, {
      architectures: ["arm64"],
      memorySize: 512,
      timeout: 10,
      ...lambda,
      runtime,
      functionName,
      // Assigned below once this construct exists to own its role.
      role: props.role ?? "",
      environment: Object.keys(variables).length ? { variables } : undefined,
      packageType: "Zip",
    });

    this.code = new NodejsAsset(this, "Code", {
      entry,
      handler,
      projectRoot,
      bundling,
      target: `node${runtimeMatch[1]}`,
    });
    this.filename = this.code.path;
    this.sourceCodeHash = this.code.sourceCodeHash;
    this.handler = this.code.handler;

    this.logGroup =
      logGroup ??
      new CloudwatchLogGroup(this, "LogGroup", {
        name: `/aws/lambda/${functionName}`,
        retentionInDays: logRetentionDays ?? 30,
        provider: props.provider,
        region: props.region,
        tags: props.tags,
      });
    this.putLoggingConfig({
      logFormat: "JSON",
      ...loggingConfig,
      logGroup: this.logGroup.name,
    });
    this.dependsOn = [...(this.dependsOn ?? []), dependable(this.logGroup)];

    if (!props.role) {
      this.executionRole = new IamRole(this, "ExecutionRole", {
        namePrefix: `${uniqueName(scope, id).slice(0, 31)}-`,
        assumeRolePolicy: Fn.jsonencode({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        provider: props.provider,
        tags: props.tags,
      });
      this.role = this.executionRole.arn;
      this.statements.push({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`${this.logGroup.arn}:*`],
      });
      if (props.vpcConfig) {
        this.statements.push({
          actions: [
            "ec2:CreateNetworkInterface",
            "ec2:DescribeNetworkInterfaces",
            "ec2:DescribeSubnets",
            "ec2:DeleteNetworkInterface",
            "ec2:AssignPrivateIpAddresses",
            "ec2:UnassignPrivateIpAddresses",
          ],
          resources: ["*"],
        });
      }
      this.statements.push(...(initialPolicy ?? []));
      this.executionPolicy = new IamRolePolicy(this, "ExecutionPolicy", {
        role: this.executionRole.name,
        policy: this.policyDocument(),
        provider: props.provider,
      });
      // An ARN reference orders the role, but not its permissions, before Lambda.
      this.dependsOn.push(dependable(this.executionPolicy));
    }
  }

  /** Add a permission to the execution role created by this function. */
  public addToRolePolicy(statement: PolicyStatement): void {
    if (!this.executionPolicy)
      throw new Error(
        "This function uses an existing role. Add permissions to that role directly.",
      );
    this.statements.push(statement);
    this.executionPolicy.policy = this.policyDocument();
  }

  /** Add a runtime environment variable without replacing the existing map. */
  public addEnvironment(name: string, value: string): void {
    this.putEnvironment({
      variables: { ...this.environmentInput?.variables, [name]: value },
    });
  }

  private policyDocument(): string {
    return Fn.jsonencode({
      Version: "2012-10-17",
      Statement: this.statements.map((statement) => ({
        Effect: statement.effect ?? "Allow",
        Action: statement.actions,
        Resource: statement.resources,
        ...(statement.conditions ? { Condition: statement.conditions } : {}),
      })),
    });
  }
}

function uniqueName(scope: Construct, id: string): string {
  const constructPath = `${scope.node.path}/${id}`;
  const suffix = createHash("sha256")
    .update(constructPath)
    .digest("hex")
    .slice(0, 8);
  return `${constructPath.replace(/[^a-zA-Z0-9_-]/g, "-").slice(-55)}-${suffix}`;
}
