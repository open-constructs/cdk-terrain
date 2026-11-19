// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  attributes,
  OpenTofuKeyProvider,
  OpenTofuKeyProviderBaseConfig,
  requirementsOf,
} from "../key-provider";
import { nestedBlock } from "../render";

/**
 * The role {@link OpenTofuAwsKmsKeyProvider} assumes.
 */
export interface OpenTofuAwsKmsAssumeRoleConfig {
  /**
   * The ARN of the role to assume.
   */
  readonly roleArn: string;

  /**
   * How long the role session lasts, between `15m` and `12h`.
   *
   * @default - set by AWS
   */
  readonly duration?: string;

  /**
   * The external ID to pass when assuming the role.
   *
   * @default - none
   */
  readonly externalId?: string;

  /**
   * An IAM policy JSON document that narrows the role's permissions.
   *
   * @default - none
   */
  readonly policy?: string;

  /**
   * ARNs of IAM policies that narrow the role's permissions.
   *
   * @default - none
   */
  readonly policyArns?: string[];

  /**
   * The session name.
   *
   * @default - none
   */
  readonly sessionName?: string;

  /**
   * Session tags.
   *
   * @default - none
   */
  readonly tags?: { [key: string]: string };

  /**
   * Keys of the session tags to pass on to roles assumed later in a chain.
   *
   * @default - none
   */
  readonly transitiveTagKeys?: string[];
}

/**
 * The role {@link OpenTofuAwsKmsKeyProvider} assumes with a web identity token.
 */
export interface OpenTofuAwsKmsAssumeRoleWithWebIdentityConfig {
  /**
   * The ARN of the role to assume.
   *
   * @default - the AWS_ROLE_ARN environment variable
   */
  readonly roleArn?: string;

  /**
   * How long the role session lasts, e.g. `1h`.
   *
   * @default - set by AWS
   */
  readonly duration?: string;

  /**
   * An IAM policy JSON document that narrows the role's permissions.
   *
   * @default - none
   */
  readonly policy?: string;

  /**
   * ARNs of IAM policies that narrow the role's permissions.
   *
   * @default - none
   */
  readonly policyArns?: string[];

  /**
   * The session name.
   *
   * @default - none
   */
  readonly sessionName?: string;

  /**
   * The web identity token. Read it from a sensitive `TerraformVariable` instead of writing it into the code.
   *
   * @default - `webIdentityTokenFile`
   */
  readonly webIdentityToken?: string;

  /**
   * A file containing the web identity token.
   *
   * @default - the AWS_WEB_IDENTITY_TOKEN_FILE environment variable
   */
  readonly webIdentityTokenFile?: string;
}

/**
 * Custom endpoints for the AWS services {@link OpenTofuAwsKmsKeyProvider} calls besides KMS.
 */
export interface OpenTofuAwsKmsEndpointsConfig {
  /**
   * The IAM endpoint.
   *
   * @default - the default endpoint
   */
  readonly iam?: string;

  /**
   * The STS endpoint.
   *
   * @default - the default endpoint
   */
  readonly sts?: string;
}

/**
 * Configuration for {@link OpenTofuAwsKmsKeyProvider}. Credentials come from the usual AWS environment variables
 * and files unless they are set here; read secrets from a sensitive `TerraformVariable`.
 */
export interface OpenTofuAwsKmsKeyProviderConfig extends OpenTofuKeyProviderBaseConfig {
  /**
   * The ID, ARN or alias of the KMS key.
   */
  readonly kmsKeyId: string;

  /**
   * The data key spec, e.g. `AES_256`.
   */
  readonly keySpec: string;

  /**
   * The AWS access key.
   *
   * @default - from the environment
   */
  readonly accessKey?: string;

  /**
   * The AWS secret key.
   *
   * @default - from the environment
   */
  readonly secretKey?: string;

  /**
   * The AWS session token.
   *
   * @default - from the environment
   */
  readonly token?: string;

  /**
   * The AWS region.
   *
   * @default - from the environment
   */
  readonly region?: string;

  /**
   * The profile in the shared configuration and credentials files.
   *
   * @default - from the environment
   */
  readonly profile?: string;

  /**
   * Paths to shared credentials files.
   *
   * @default - ~/.aws/credentials
   */
  readonly sharedCredentialsFiles?: string[];

  /**
   * Paths to shared configuration files.
   *
   * @default - ~/.aws/config
   */
  readonly sharedConfigFiles?: string[];

  /**
   * The role to assume.
   *
   * @default - no role
   */
  readonly assumeRole?: OpenTofuAwsKmsAssumeRoleConfig;

  /**
   * The role to assume with a web identity token.
   *
   * @default - no role
   */
  readonly assumeRoleWithWebIdentity?: OpenTofuAwsKmsAssumeRoleWithWebIdentityConfig;

  /**
   * The account IDs that are allowed, to guard against the wrong credentials.
   *
   * @default - any account
   */
  readonly allowedAccountIds?: string[];

  /**
   * The account IDs that are refused.
   *
   * @default - none
   */
  readonly forbiddenAccountIds?: string[];

  /**
   * Custom endpoints for IAM and STS.
   *
   * @default - the default endpoints
   */
  readonly endpoints?: OpenTofuAwsKmsEndpointsConfig;

  /**
   * The region for STS calls.
   *
   * @default - `region`
   */
  readonly stsRegion?: string;

  /**
   * The maximum number of retries for an AWS API call.
   *
   * @default 5
   */
  readonly maxRetries?: number;

  /**
   * How retries are made, `standard` or `adaptive`.
   *
   * @default - set by the AWS SDK
   */
  readonly retryMode?: string;

  /**
   * Whether to skip validating the credentials through STS.
   *
   * @default false
   */
  readonly skipCredentialsValidation?: boolean;

  /**
   * Whether to skip looking up the account ID.
   *
   * @default false
   */
  readonly skipRequestingAccountId?: boolean;

  /**
   * Whether to skip the EC2 metadata API check.
   *
   * @default - the AWS_EC2_METADATA_DISABLED environment variable
   */
  readonly skipMetadataApiCheck?: boolean;

  /**
   * The EC2 metadata service endpoint.
   *
   * @default - the default endpoint
   */
  readonly ec2MetadataServiceEndpoint?: string;

  /**
   * The EC2 metadata service endpoint mode, `IPv4` or `IPv6`.
   *
   * @default - the AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE environment variable
   */
  readonly ec2MetadataServiceEndpointMode?: string;

  /**
   * The HTTP proxy.
   *
   * @default - the HTTP_PROXY environment variable
   */
  readonly httpProxy?: string;

  /**
   * The HTTPS proxy.
   *
   * @default - the HTTPS_PROXY environment variable
   */
  readonly httpsProxy?: string;

  /**
   * Hosts that bypass the proxy.
   *
   * @default - the NO_PROXY environment variable
   */
  readonly noProxy?: string;

  /**
   * Whether to skip verifying TLS certificates.
   *
   * @default false
   */
  readonly insecure?: boolean;

  /**
   * A file of CA certificates to trust.
   *
   * @default - the system's
   */
  readonly customCaBundle?: string;

  /**
   * Whether to use dual-stack endpoints.
   *
   * @default false
   */
  readonly useDualstackEndpoint?: boolean;

  /**
   * Whether to use FIPS endpoints.
   *
   * @default false
   */
  readonly useFipsEndpoint?: boolean;
}

/**
 * Generates keys with AWS KMS.
 */
export class OpenTofuAwsKmsKeyProvider extends OpenTofuKeyProvider {
  /**
   * @param name - a name for the key provider, unique among `aws_kms` key providers
   * @param config - the KMS key and the AWS settings
   */
  constructor(name: string, config: OpenTofuAwsKmsKeyProviderConfig) {
    super("aws_kms", name, {
      ...attributes(config, [
        "kmsKeyId",
        "keySpec",
        "accessKey",
        "secretKey",
        "token",
        "region",
        "profile",
        "sharedCredentialsFiles",
        "sharedConfigFiles",
      ]),
      assume_role:
        config.assumeRole &&
        attributes(config.assumeRole, [
          "roleArn",
          "duration",
          "externalId",
          "policy",
          "policyArns",
          "sessionName",
          "tags",
          "transitiveTagKeys",
        ]),
      assume_role_with_web_identity:
        config.assumeRoleWithWebIdentity &&
        attributes(config.assumeRoleWithWebIdentity, [
          "roleArn",
          "duration",
          "policy",
          "policyArns",
          "sessionName",
          "webIdentityToken",
          "webIdentityTokenFile",
        ]),
      ...attributes(config, [
        "allowedAccountIds",
        "forbiddenAccountIds",
        "stsRegion",
        "maxRetries",
        "retryMode",
        "skipCredentialsValidation",
        "skipRequestingAccountId",
        "skipMetadataApiCheck",
        "ec2MetadataServiceEndpoint",
        "ec2MetadataServiceEndpointMode",
        "httpProxy",
        "httpsProxy",
        "noProxy",
        "insecure",
        "customCaBundle",
        "useDualstackEndpoint",
        "useFipsEndpoint",
        "encryptedMetadataAlias",
      ]),
      // OpenTofu reads endpoints as a block, unlike assume_role
      endpoints:
        config.endpoints &&
        nestedBlock(attributes(config.endpoints, ["iam", "sts"])),
    });
    this._requires.push(...requirementsOf(config));
  }
}
