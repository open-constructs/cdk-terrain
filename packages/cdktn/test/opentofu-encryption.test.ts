// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  App,
  AnnotationMetadataEntryType,
  DataResource,
  DataTerraformRemoteStateLocal,
  Fn,
  LocalBackend,
  Manifest,
  OpenTofuAesGcmMethod,
  OpenTofuAwsKmsKeyProvider,
  OpenTofuAzureVaultKeyProvider,
  OpenTofuEncryption,
  OpenTofuEncryptionMethod,
  OpenTofuExternalKeyProvider,
  OpenTofuExternalMethod,
  OpenTofuGcpKmsKeyProvider,
  OpenTofuKeyProvider,
  OpenTofuOpenBaoKeyProvider,
  OpenTofuPbkdf2KeyProvider,
  OpenTofuUnencryptedMethod,
  TerraformIterator,
  TerraformOutput,
  TerraformStack,
  TerraformVariable,
  Testing,
  Token,
} from "../src";
import { TerraformTargetVersions } from "../src/validations/target-versions";

const readStackFile = (outdir: string, file: string, stack = "test") => {
  const filePath = path.join(outdir, "stacks", stack, file);
  return fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : undefined;
};

const readJson = (outdir: string, file: string, stack = "test") => {
  const content = readStackFile(outdir, file, stack);
  return content === undefined ? undefined : JSON.parse(content);
};

const warnings = (outdir: string): string[] =>
  JSON.parse(fs.readFileSync(path.join(outdir, Manifest.fileName), "utf-8"))
    .stacks.test.annotations.filter(
      (annotation: { level: string }) =>
        annotation.level === AnnotationMetadataEntryType.WARN,
    )
    .map((annotation: { message: string }) => annotation.message);

const stackTargeting = (targetVersions?: TerraformTargetVersions) =>
  new TerraformStack(
    Testing.app({ context: targetVersions && { targetVersions } }),
    "test",
  );

const passphraseKey = (stack: TerraformStack) =>
  new OpenTofuPbkdf2KeyProvider("main", {
    passphrase: new TerraformVariable(stack, "state_passphrase", {
      type: "string",
      sensitive: true,
    }).stringValue,
  });

// a passphrase from a variable, aes_gcm, and an unencrypted fallback for migrating existing state
const encryptWithPassphrase = (stack: TerraformStack) => {
  const aes = new OpenTofuAesGcmMethod("main", {
    keys: passphraseKey(stack),
  });
  return new OpenTofuEncryption(stack, "encryption", {
    state: {
      method: aes,
      fallback: new OpenTofuUnencryptedMethod("migrate"),
    },
    plan: { method: aes, enforced: true },
  });
};

test("writes the encryption block to settings.tofu.json only, with the key providers and methods its targets use", () => {
  const stack = stackTargeting({ opentofu: ">=1.8.0" });
  const encryption = encryptWithPassphrase(stack);
  encryption.remoteState = { method: encryption.plan!.method };

  const outdir = Testing.fullSynth(stack);

  // OpenTofu rejects "${...}" around keys and method references
  expect(readJson(outdir, "settings.tofu.json")).toEqual({
    terraform: {
      required_version: ">= 1.8.0",
      encryption: {
        key_provider: {
          pbkdf2: { main: { passphrase: "${var.state_passphrase}" } },
        },
        method: {
          aes_gcm: { main: { keys: "key_provider.pbkdf2.main" } },
          unencrypted: { migrate: {} },
        },
        state: {
          method: "method.aes_gcm.main",
          fallback: { method: "method.unencrypted.migrate" },
        },
        plan: { method: "method.aes_gcm.main", enforced: true },
        remote_state_data_sources: {
          default: { method: "method.aes_gcm.main" },
        },
      },
    },
  });
  // Terraform reads these and rejects an encryption block
  expect(readJson(outdir, "settings.tf.json")).toEqual({
    terraform: { required_version: ">= 1.8.0" },
  });
  expect(readStackFile(outdir, "cdk.tf.json")).not.toContain("encryption");
});

test("writes the encryption block to settings.tofu with HCL output, with assume_role as an attribute and endpoints as a block", () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktf.outdir."));
  const app = new App({
    outdir,
    hclOutput: true,
    context: { targetVersions: { opentofu: ">=1.10.0" } },
  });
  const stack = new TerraformStack(app, "test");
  // OpenTofu rejects assume_role as a block, and endpoints as an attribute
  const kms = new OpenTofuAwsKmsKeyProvider("kms", {
    kmsKeyId: "alias/state",
    keySpec: "AES_256",
    assumeRole: { roleArn: "arn:aws:iam::123456789012:role/state" },
    endpoints: { sts: "https://sts.example.com" },
  });
  const chained = new OpenTofuPbkdf2KeyProvider("chained", { chain: kms });
  new OpenTofuEncryption(stack, "encryption", {
    state: {
      method: new OpenTofuAesGcmMethod("main", { keys: chained }),
      fallback: new OpenTofuUnencryptedMethod("migrate"),
    },
  });

  app.synth();

  expect(readStackFile(outdir, "settings.tofu")).toEqual(`terraform {
  required_version = ">= 1.10.0"
  encryption {
    key_provider "pbkdf2" "chained" {
      chain = key_provider.aws_kms.kms
    }
    key_provider "aws_kms" "kms" {
      kms_key_id = "alias/state"
      key_spec = "AES_256"
      assume_role = { "role_arn" = "arn:aws:iam::123456789012:role/state" }
      endpoints {
        sts = "https://sts.example.com"
      }
    }
    method "aes_gcm" "main" {
      keys = key_provider.pbkdf2.chained
    }
    method "unencrypted" "migrate" {}
    state {
      method = method.aes_gcm.main
      fallback {
        method = method.unencrypted.migrate
      }
    }
  }
}
`);
});

// every field set; the expected names are OpenTofu 1.12's, and tofu init decodes this output
test.each<
  [
    string,
    string[],
    () => OpenTofuKeyProvider | OpenTofuEncryptionMethod,
    string[],
  ]
>([
  [
    "aws_kms",
    ["key_provider", "aws_kms", "main"],
    () =>
      new OpenTofuAwsKmsKeyProvider("main", {
        kmsKeyId: "alias/state",
        keySpec: "AES_256",
        accessKey: "a",
        secretKey: "s",
        token: "t",
        region: "us-east-1",
        profile: "p",
        sharedCredentialsFiles: ["c"],
        sharedConfigFiles: ["c"],
        assumeRole: { roleArn: "arn" },
        assumeRoleWithWebIdentity: { roleArn: "arn" },
        allowedAccountIds: ["1"],
        forbiddenAccountIds: ["2"],
        stsRegion: "us-east-1",
        maxRetries: 1,
        retryMode: "standard",
        skipCredentialsValidation: true,
        skipRequestingAccountId: true,
        skipMetadataApiCheck: true,
        ec2MetadataServiceEndpoint: "http://169.254.169.254",
        ec2MetadataServiceEndpointMode: "IPv4",
        httpProxy: "http://proxy",
        httpsProxy: "http://proxy",
        noProxy: "localhost",
        insecure: false,
        customCaBundle: "ca.pem",
        useDualstackEndpoint: false,
        useFipsEndpoint: false,
        endpoints: { iam: "http://iam", sts: "http://sts" },
        encryptedMetadataAlias: "alias",
      }),
    [
      "access_key",
      "allowed_account_ids",
      "assume_role",
      "assume_role_with_web_identity",
      "custom_ca_bundle",
      "ec2_metadata_service_endpoint",
      "ec2_metadata_service_endpoint_mode",
      "encrypted_metadata_alias",
      "endpoints",
      "forbidden_account_ids",
      "http_proxy",
      "https_proxy",
      "insecure",
      "key_spec",
      "kms_key_id",
      "max_retries",
      "no_proxy",
      "profile",
      "region",
      "retry_mode",
      "secret_key",
      "shared_config_files",
      "shared_credentials_files",
      "skip_credentials_validation",
      "skip_metadata_api_check",
      "skip_requesting_account_id",
      "sts_region",
      "token",
      "use_dualstack_endpoint",
      "use_fips_endpoint",
    ],
  ],
  [
    "aws_kms assume_role",
    ["key_provider", "aws_kms", "main", "assume_role"],
    () =>
      new OpenTofuAwsKmsKeyProvider("main", {
        kmsKeyId: "alias/state",
        keySpec: "AES_256",
        assumeRole: {
          roleArn: "arn",
          duration: "1h",
          externalId: "e",
          policy: "{}",
          policyArns: ["arn"],
          sessionName: "s",
          tags: { Team: "infra" },
          transitiveTagKeys: ["Team"],
        },
      }),
    [
      "duration",
      "external_id",
      "policy",
      "policy_arns",
      "role_arn",
      "session_name",
      "tags",
      "transitive_tag_keys",
    ],
  ],
  [
    "aws_kms assume_role_with_web_identity",
    ["key_provider", "aws_kms", "main", "assume_role_with_web_identity"],
    () =>
      new OpenTofuAwsKmsKeyProvider("main", {
        kmsKeyId: "alias/state",
        keySpec: "AES_256",
        assumeRoleWithWebIdentity: {
          roleArn: "arn",
          duration: "1h",
          policy: "{}",
          policyArns: ["arn"],
          sessionName: "s",
          webIdentityToken: "t",
          webIdentityTokenFile: "f",
        },
      }),
    [
      "duration",
      "policy",
      "policy_arns",
      "role_arn",
      "session_name",
      "web_identity_token",
      "web_identity_token_file",
    ],
  ],
  [
    "gcp_kms",
    ["key_provider", "gcp_kms", "main"],
    () =>
      new OpenTofuGcpKmsKeyProvider("main", {
        kmsEncryptionKey: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
        keyLength: 32,
        credentials: "c",
        accessToken: "t",
        impersonateServiceAccount: "sa",
        impersonateServiceAccountDelegates: ["d"],
        encryptedMetadataAlias: "alias",
      }),
    [
      "access_token",
      "credentials",
      "encrypted_metadata_alias",
      "impersonate_service_account",
      "impersonate_service_account_delegates",
      "key_length",
      "kms_encryption_key",
    ],
  ],
  [
    "azure_vault",
    ["key_provider", "azure_vault", "main"],
    () =>
      new OpenTofuAzureVaultKeyProvider("main", {
        vaultUri: "https://v.vault.azure.net",
        vaultKeyName: "k",
        keyLength: 32,
        symmetric: true,
        symmetricKeySize: 256,
        tenantId: "t",
        subscriptionId: "s",
        environment: "public",
        metadataHost: "h",
        useCli: false,
        clientId: "c",
        clientIdFilePath: "f",
        clientSecret: "s",
        clientSecretFilePath: "f",
        clientCertificate: "c",
        clientCertificatePassword: "p",
        clientCertificatePath: "f",
        useOidc: true,
        oidcToken: "t",
        oidcTokenFilePath: "f",
        oidcRequestUrl: "http://oidc",
        oidcRequestToken: "t",
        useMsi: true,
        msiEndpoint: "http://msi",
        useAksWorkloadIdentity: false,
        encryptedMetadataAlias: "alias",
      }),
    [
      "client_certificate",
      "client_certificate_password",
      "client_certificate_path",
      "client_id",
      "client_id_file_path",
      "client_secret",
      "client_secret_file_path",
      "encrypted_metadata_alias",
      "environment",
      "key_length",
      "metadata_host",
      "msi_endpoint",
      "oidc_request_token",
      "oidc_request_url",
      "oidc_token",
      "oidc_token_file_path",
      "subscription_id",
      "symmetric",
      "symmetric_key_size",
      "tenant_id",
      "use_aks_workload_identity",
      "use_cli",
      "use_msi",
      "use_oidc",
      "vault_key_name",
      "vault_uri",
    ],
  ],
  [
    "openbao",
    ["key_provider", "openbao", "main"],
    () =>
      new OpenTofuOpenBaoKeyProvider("main", {
        keyName: "k",
        keyLength: 32,
        transitEnginePath: "/transit",
        address: "http://bao",
        token: "t",
        encryptedMetadataAlias: "alias",
      }),
    [
      "address",
      "encrypted_metadata_alias",
      "key_length",
      "key_name",
      "token",
      "transit_engine_path",
    ],
  ],
  [
    "external key provider",
    ["key_provider", "external", "main"],
    () =>
      new OpenTofuExternalKeyProvider("main", {
        command: ["keys"],
        encryptedMetadataAlias: "alias",
      }),
    ["command", "encrypted_metadata_alias"],
  ],
  [
    "external method",
    ["method", "external", "main"],
    () =>
      new OpenTofuExternalMethod("main", {
        keys: new OpenTofuPbkdf2KeyProvider("main", {
          passphrase: "p".repeat(16),
        }),
        encryptCommand: ["encrypt"],
        decryptCommand: ["decrypt"],
      }),
    ["decrypt_command", "encrypt_command", "keys"],
  ],
])(
  "writes every %s attribute under OpenTofu's name",
  (_, path, create, names) => {
    const stack = stackTargeting({ opentofu: ">=1.11.0" });
    const element = create();
    new OpenTofuEncryption(stack, "encryption", {
      state: {
        method:
          path[0] === "method"
            ? (element as OpenTofuEncryptionMethod)
            : new OpenTofuAesGcmMethod("main", {
                keys: element as OpenTofuKeyProvider,
              }),
      },
    });

    const outdir = Testing.fullSynth(stack);

    const written = path.reduce(
      (block, key) => block[key],
      readJson(outdir, "settings.tofu.json").terraform.encryption,
    );
    expect(Object.keys(written).sort()).toEqual(names);
  },
);

test("writes expressions in settings.tofu unescaped and escapes only literal text", () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktf.outdir."));
  const app = new App({
    outdir,
    hclOutput: true,
    context: { targetVersions: { opentofu: ">=1.8.0" } },
  });
  const stack = new TerraformStack(app, "test");
  const keys = (name: string, passphrase: string) =>
    new OpenTofuAesGcmMethod(name, {
      keys: new OpenTofuPbkdf2KeyProvider(name, { passphrase }),
    });
  new OpenTofuEncryption(stack, "encryption", {
    state: { method: keys("file", Fn.trimspace(Fn.file("pass.txt"))) },
    plan: { method: keys("literal", 'a "quoted" \\ passphrase') },
    remoteState: {
      method: keys("directive", '%{ if "a" == "a" }bell\u0007%{ endif }'),
    },
  });

  app.synth();

  // escaping the quotes inside ${...} makes OpenTofu fail with "Invalid character"
  const settings = readStackFile(outdir, "settings.tofu");
  expect(settings).toContain('passphrase = "${trimspace(file("pass.txt"))}"');
  expect(settings).toContain('passphrase = "a \\"quoted\\" \\\\ passphrase"');
  // HCL doesn't accept raw control characters in a quoted template
  expect(settings).toContain(
    'passphrase = "%{ if "a" == "a" }bell\\u0007%{ endif }"',
  );
});

test("accepts the loop variables of for expressions and directives, which aren't references", () => {
  const stack = stackTargeting({ opentofu: ">=1.8.0" });
  const parts = new TerraformVariable(stack, "parts", {
    type: "list(object({ value = string }))",
  });
  const keys = (name: string, passphrase: string) =>
    new OpenTofuAesGcmMethod(name, {
      keys: new OpenTofuPbkdf2KeyProvider(name, { passphrase }),
    });
  new OpenTofuEncryption(stack, "encryption", {
    // [for key, val in toset(var.parts): val.value]
    state: {
      method: keys(
        "expression",
        Fn.join(
          "",
          Token.asList(
            TerraformIterator.fromList(parts.listValue).pluckProperty("value"),
          ),
        ),
      ),
    },
    plan: {
      method: keys("directive", "%{ for p in var.parts }${p.value}%{ endfor }"),
    },
  });

  expect(() => Testing.fullSynth(stack)).not.toThrow();
});

test("decrypts remote state per source, labelled with the data source's name", () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktf.outdir."));
  const app = new App({
    outdir,
    context: { targetVersions: { opentofu: ">=1.8.0" } },
  });
  const network = new TerraformStack(app, "network");
  new LocalBackend(network, { path: "network.tfstate" });
  const id = new TerraformVariable(network, "id", { type: "string" });
  const consumer = new TerraformStack(app, "test");
  new TerraformOutput(consumer, "network_id", { value: id.stringValue });
  const legacy = new DataTerraformRemoteStateLocal(consumer, "legacy", {
    path: "legacy.tfstate",
  });

  const aes = new OpenTofuAesGcmMethod("main", {
    keys: passphraseKey(consumer),
  });
  const encryption = new OpenTofuEncryption(consumer, "encryption", {
    remoteState: { method: aes },
    remoteStateSources: [
      {
        fromStack: network,
        method: OpenTofuEncryptionMethod.fromEnvironment("aes_gcm", "network"),
      },
    ],
  });
  encryption.addRemoteStateSource({
    dataSource: legacy,
    method: new OpenTofuUnencryptedMethod("legacy"),
  });

  app.synth();

  const dataSources = readJson(outdir, "cdk.tf.json").data
    .terraform_remote_state;
  const { method, remote_state_data_sources } = readJson(
    outdir,
    "settings.tofu.json",
  ).terraform.encryption;
  // OpenTofu matches a source by the data source's bare name
  expect(Object.keys(dataSources).sort()).toEqual([
    "cross-stack-reference-input-network",
    "legacy",
  ]);
  expect(remote_state_data_sources).toEqual({
    default: { method: "method.aes_gcm.main" },
    remote_state_data_source: {
      "cross-stack-reference-input-network": {
        method: "method.aes_gcm.network",
      },
      legacy: { method: "method.unencrypted.legacy" },
    },
  });
  // the fromEnvironment method is referenced but not declared
  expect(method).toEqual({
    aes_gcm: { main: expect.anything() },
    unencrypted: { legacy: {} },
  });
});

test("writes and checks nothing for a fromStack source whose stack isn't referenced", () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktf.outdir."));
  const app = new App({
    outdir,
    context: { targetVersions: { opentofu: ">=1.8.0" } },
  });
  const network = new TerraformStack(app, "network");
  OpenTofuEncryption.withKeys(network, "encryption", {
    keys: new OpenTofuPbkdf2KeyProvider("network", {
      passphrase: "n".repeat(16),
    }),
  });
  const consumer = new TerraformStack(app, "test");
  new OpenTofuEncryption(consumer, "encryption", {
    remoteStateSources: [
      {
        fromStack: network,
        // doesn't match network's key provider, and uses a resource
        method: new OpenTofuAesGcmMethod("network", {
          keys: new OpenTofuPbkdf2KeyProvider("other", {
            passphrase: new DataResource(consumer, "passphrase", {
              input: { value: "x" },
            }).id,
          }),
        }),
      },
    ],
  });

  app.synth();

  expect(readJson(outdir, "settings.tofu.json").terraform.encryption).toEqual(
    {},
  );
});

// a consumer that reads network's state, with the default remoteState or a source with the given key provider
const consumerOfNetwork = (sourceKeys?: OpenTofuKeyProvider) => {
  const app = Testing.app({
    context: { targetVersions: { opentofu: ">=1.9.0" } },
  });
  const network = new TerraformStack(app, "network");
  const id = new TerraformVariable(network, "id", { type: "string" });
  OpenTofuEncryption.withKeys(network, "encryption", {
    keys: new OpenTofuPbkdf2KeyProvider("network", {
      passphrase: "n".repeat(16),
    }),
  });
  const consumer = new TerraformStack(app, "test");
  new TerraformOutput(consumer, "network_id", { value: id.stringValue });
  const encryption = OpenTofuEncryption.withKeys(consumer, "encryption", {
    keys: passphraseKey(consumer),
  });
  if (sourceKeys) {
    encryption.addRemoteStateSource({
      fromStack: network,
      method: new OpenTofuAesGcmMethod("network", { keys: sourceKeys }),
    });
  }
  return app;
};

test.each<[string, OpenTofuKeyProvider | undefined, string]>([
  [
    "the default",
    undefined,
    "The stack at 'test' decrypts the state of the stack at 'network' with key_provider.pbkdf2.main, but that stack encrypts its state with key_provider.pbkdf2.network. OpenTofu finds the key by the key provider's type and name, so use a key provider with the same type and name, or the same encryptedMetadataAlias, in both stacks.",
  ],
  [
    "a source",
    new OpenTofuPbkdf2KeyProvider("other", { passphrase: "n".repeat(16) }),
    "The stack at 'test' decrypts the state of the stack at 'network' with key_provider.pbkdf2.other, but that stack encrypts its state with key_provider.pbkdf2.network.",
  ],
])(
  "fails synth when %s doesn't match the key provider the other stack encrypts with",
  (_, sourceKeys, error) => {
    expect(() => consumerOfNetwork(sourceKeys).synth()).toThrow(error);
  },
);

test.each<[string, OpenTofuKeyProvider]>([
  [
    "the other stack's type and name",
    new OpenTofuPbkdf2KeyProvider("network", { passphrase: "n".repeat(16) }),
  ],
  [
    "the other stack's metadata key as its alias",
    new OpenTofuPbkdf2KeyProvider("renamed", {
      passphrase: "n".repeat(16),
      encryptedMetadataAlias: "key_provider.pbkdf2.network",
    }),
  ],
])("synthesizes when a source's key provider has %s", (_, sourceKeys) => {
  expect(() => consumerOfNetwork(sourceKeys).synth()).not.toThrow();
});

test.each([false, true])(
  "withKeys encrypts state and plan and decrypts remote state, migrating from unencrypted: %s",
  (migrateFromUnencrypted) => {
    const stack = stackTargeting({ opentofu: ">=1.8.0" });
    OpenTofuEncryption.withKeys(stack, "encryption", {
      keys: passphraseKey(stack),
      migrateFromUnencrypted,
    });

    const outdir = Testing.fullSynth(stack);

    const migrate = { fallback: { method: "method.unencrypted.migrate" } };
    expect(readJson(outdir, "settings.tofu.json").terraform.encryption).toEqual(
      {
        key_provider: { pbkdf2: { main: expect.anything() } },
        method: {
          aes_gcm: { main: { keys: "key_provider.pbkdf2.main" } },
          ...(migrateFromUnencrypted && { unencrypted: { migrate: {} } }),
        },
        // OpenTofu rejects an unencrypted fallback in an enforced target
        state: migrateFromUnencrypted
          ? { method: "method.aes_gcm.main", ...migrate }
          : { method: "method.aes_gcm.main", enforced: true },
        plan: { method: "method.aes_gcm.main", enforced: true },
        remote_state_data_sources: {
          default: {
            method: "method.aes_gcm.main",
            ...(migrateFromUnencrypted && migrate),
          },
        },
      },
    );
  },
);

test("warns that Terraform writes unencrypted state when the project also targets Terraform", () => {
  const stack = stackTargeting({ terraform: ">=1.5.7", opentofu: ">=1.8.0" });
  encryptWithPassphrase(stack);

  const outdir = Testing.fullSynth(stack);

  expect(warnings(outdir)).toEqual([
    "The project targets terraform >=1.5.7, but Terraform doesn't support state encryption, so the state and plan files Terraform writes for this stack aren't encrypted. Declare targetVersions without terraform if the project only runs OpenTofu.",
  ]);
  expect(readJson(outdir, "settings.tofu.json").terraform.encryption).toEqual(
    expect.objectContaining({ state: expect.anything() }),
  );
});

test.each<
  [
    string,
    TerraformTargetVersions | undefined,
    string,
    (s: TerraformStack) => void,
  ]
>([
  [
    "targetVersions isn't declared",
    undefined,
    `OpenTofu encryption requires opentofu >=1.8.0, but the project targets opentofu >=1.6.0. OpenTofu 1.7 doesn't read settings.tofu.json, where cdktn writes the encryption block. Set targetVersions.opentofu to ">=1.8.0" or narrower.`,
    encryptWithPassphrase,
  ],
  [
    "the OpenTofu range allows 1.7, which doesn't read settings.tofu.json",
    { opentofu: ">=1.7.0" },
    `OpenTofu encryption requires opentofu >=1.8.0, but the project targets opentofu >=1.7.0.`,
    encryptWithPassphrase,
  ],
  [
    "the project doesn't target OpenTofu",
    { terraform: ">=1.5.7" },
    `OpenTofu encryption is only supported by OpenTofu, but the project doesn't target it. Set targetVersions.opentofu to ">=1.8.0" or narrower.`,
    encryptWithPassphrase,
  ],
  [
    "a key provider attribute needs a newer OpenTofu than the project targets",
    { opentofu: ">=1.8.0" },
    "The pbkdf2 key provider's chain attribute requires opentofu >=1.10.0, but the project targets opentofu >=1.8.0.",
    (stack) =>
      OpenTofuEncryption.withKeys(stack, "encryption", {
        keys: new OpenTofuPbkdf2KeyProvider("chained", {
          chain: passphraseKey(stack),
        }),
      }),
  ],
  [
    "a key provider needs a newer OpenTofu than the project targets",
    { opentofu: ">=1.10.0" },
    "The azure_vault key provider requires opentofu >=1.11.0, but the project targets opentofu >=1.10.0.",
    (stack) =>
      OpenTofuEncryption.withKeys(stack, "encryption", {
        keys: new OpenTofuAzureVaultKeyProvider("main", {
          vaultUri: "https://example.vault.azure.net",
          vaultKeyName: "state",
          keyLength: 32,
        }),
      }),
  ],
  [
    "a key provider uses a variable of another stack, which OpenTofu can't see",
    { opentofu: ">=1.8.0" },
    "key_provider.pbkdf2.main uses var.other_passphrase, which the stack at 'test' doesn't declare.",
    (stack) => {
      const other = new TerraformStack(stack.node.scope!, "other");
      OpenTofuEncryption.withKeys(stack, "encryption", {
        keys: new OpenTofuPbkdf2KeyProvider("main", {
          passphrase: new TerraformVariable(other, "other_passphrase", {
            type: "string",
          }).stringValue,
        }),
      });
    },
  ],
  [
    "a key provider uses a resource, which OpenTofu can't evaluate in the encryption block",
    { opentofu: ">=1.8.0" },
    "key_provider.pbkdf2.main uses terraform_data.passphrase, but OpenTofu evaluates the encryption block before planning, so it can only use variables, locals and functions.",
    (stack) =>
      OpenTofuEncryption.withKeys(stack, "encryption", {
        keys: new OpenTofuPbkdf2KeyProvider("main", {
          passphrase: new DataResource(stack, "passphrase", {
            input: { value: "x" },
          }).id,
        }),
      }),
  ],
  [
    "a key provider uses a resource in a template directive",
    { opentofu: ">=1.8.0" },
    "key_provider.pbkdf2.main uses terraform_data.flag, but OpenTofu evaluates the encryption block before planning",
    (stack) =>
      OpenTofuEncryption.withKeys(stack, "encryption", {
        keys: new OpenTofuPbkdf2KeyProvider("main", {
          passphrase: '%{ if terraform_data.flag.id != "" }a%{ endif }',
        }),
      }),
  ],
  ...[
    "${[for terraform_data in var.parts : terraform_data.value]}${terraform_data.flag.id}",
    "%{ for terraform_data in var.parts }${terraform_data}%{ endfor }${terraform_data.flag.id}",
  ].map<
    [string, TerraformTargetVersions, string, (stack: TerraformStack) => void]
  >((passphrase) => [
    `a key provider uses a resource named like a loop variable outside its loop: ${passphrase}`,
    { opentofu: ">=1.8.0" },
    "key_provider.pbkdf2.main uses terraform_data.flag, but OpenTofu evaluates the encryption block before planning",
    (stack) => {
      new TerraformVariable(stack, "parts", { type: "list(string)" });
      OpenTofuEncryption.withKeys(stack, "encryption", {
        keys: new OpenTofuPbkdf2KeyProvider("main", { passphrase }),
      });
    },
  ]),
  [
    "a method needs a newer OpenTofu than the project targets",
    { opentofu: ">=1.9.0" },
    "The external encryption method requires opentofu >=1.10.0, but the project targets opentofu >=1.9.0.",
    (stack) =>
      new OpenTofuEncryption(stack, "encryption", {
        state: {
          method: new OpenTofuExternalMethod("main", {
            encryptCommand: ["encrypt"],
            decryptCommand: ["decrypt"],
          }),
        },
      }),
  ],
  [
    "an enforced target uses the unencrypted method, which OpenTofu rejects",
    { opentofu: ">=1.8.0" },
    "The state encryption is enforced, but uses method.unencrypted.migrate, which OpenTofu rejects when enforced.",
    (stack) => {
      const encryption = encryptWithPassphrase(stack);
      encryption.state = { ...encryption.state!, enforced: true };
    },
  ],
])("fails synth when %s", (_, targetVersions, error, configure) => {
  const stack = stackTargeting(targetVersions);
  configure(stack);

  expect(() => Testing.fullSynth(stack)).toThrow(error);
});

test("still writes the encryption block when validation is skipped", () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktf.outdir."));
  const app = new App({ outdir, skipValidation: true });
  encryptWithPassphrase(new TerraformStack(app, "test"));

  app.synth();

  // without targetVersions, no required_version is written, but the encryption must not be dropped silently
  expect(readJson(outdir, "settings.tofu.json")).toEqual({
    terraform: {
      encryption: expect.objectContaining({ state: expect.anything() }),
    },
  });
  expect(readStackFile(outdir, "settings.tf.json")).toBeUndefined();
});

test.each<[string, (stack: TerraformStack) => void, string]>([
  [
    "a second OpenTofuEncryption in the stack",
    (stack) => {
      new OpenTofuEncryption(stack, "first");
      new OpenTofuEncryption(stack, "second");
    },
    "The stack at 'test' already has an OpenTofuEncryption.",
  ],
  [
    "two different key providers with the same type and name",
    (stack) => {
      const keys = (passphrase: string) =>
        new OpenTofuPbkdf2KeyProvider("main", { passphrase });
      new OpenTofuEncryption(stack, "encryption", {
        state: {
          method: new OpenTofuAesGcmMethod("state", {
            keys: keys("a"),
          }),
        },
        plan: {
          method: new OpenTofuAesGcmMethod("plan", { keys: keys("b") }),
        },
      });
      Testing.fullSynth(stack);
    },
    "OpenTofuEncryption uses two different objects named key_provider.pbkdf2.main.",
  ],
  [
    "a method name that isn't an identifier, since references are written unquoted",
    () => new OpenTofuUnencryptedMethod("main } evil {"),
    `"main } evil {" isn't a valid OpenTofu encryption type or name.`,
  ],
  [
    "a second remote state source for the same stack",
    (stack) => {
      const other = new TerraformStack(stack.node.scope!, "other");
      const encryption = new OpenTofuEncryption(stack, "encryption");
      const source = {
        fromStack: other,
        method: new OpenTofuUnencryptedMethod("other"),
      };
      encryption.addRemoteStateSource(source);
      encryption.addRemoteStateSource(source);
    },
    "OpenTofuEncryption already has a remote state source for 'other'.",
  ],
  [
    "a remote state source with another stack's data source",
    (stack) => {
      const other = new TerraformStack(stack.node.scope!, "other");
      new OpenTofuEncryption(stack, "encryption").addRemoteStateSource({
        dataSource: new DataTerraformRemoteStateLocal(other, "legacy", {
          path: "legacy.tfstate",
        }),
        method: new OpenTofuUnencryptedMethod("legacy"),
      });
    },
    "The remote state data source at 'other/legacy' isn't in the stack at 'test'.",
  ],
  [
    "a remote state source without a data source or stack",
    (stack) =>
      new OpenTofuEncryption(stack, "encryption").addRemoteStateSource({
        method: new OpenTofuUnencryptedMethod("migrate"),
      }),
    "An OpenTofuEncryption remote state source needs exactly one of fromStack and dataSource.",
  ],
])("throws for %s", (_, misuse, error) => {
  const stack = stackTargeting({ opentofu: ">=1.8.0" });

  expect(() => misuse(stack)).toThrow(error);
});
