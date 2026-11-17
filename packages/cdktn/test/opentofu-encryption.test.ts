// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  App,
  AnnotationMetadataEntryType,
  DataTerraformRemoteStateLocal,
  LocalBackend,
  Manifest,
  OpenTofuEncryption,
  OpenTofuEncryptionMethod,
  OpenTofuKeyProvider,
  TerraformOutput,
  TerraformStack,
  TerraformVariable,
  Testing,
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
  OpenTofuKeyProvider.pbkdf2("main", {
    passphrase: new TerraformVariable(stack, "state_passphrase", {
      type: "string",
      sensitive: true,
    }).stringValue,
  });

// a passphrase from a variable, aes_gcm, and an unencrypted fallback for migrating existing state
const encryptWithPassphrase = (stack: TerraformStack) => {
  const aes = OpenTofuEncryptionMethod.aesGcm("main", {
    keys: passphraseKey(stack),
  });
  return new OpenTofuEncryption(stack, "encryption", {
    state: {
      method: aes,
      fallback: OpenTofuEncryptionMethod.unencrypted("migrate"),
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

test("writes the encryption block to settings.tofu with HCL output, with config objects as attributes", () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktf.outdir."));
  const app = new App({
    outdir,
    hclOutput: true,
    context: { targetVersions: { opentofu: ">=1.10.0" } },
  });
  const stack = new TerraformStack(app, "test");
  // assume_role is an attribute; OpenTofu rejects it as a block
  const kms = OpenTofuKeyProvider.custom("aws_kms", "kms", {
    kms_key_id: "alias/state",
    assume_role: { role_arn: "arn:aws:iam::123456789012:role/state" },
  });
  const chained = OpenTofuKeyProvider.pbkdf2("chained", { chain: kms });
  new OpenTofuEncryption(stack, "encryption", {
    state: {
      method: OpenTofuEncryptionMethod.aesGcm("main", { keys: chained }),
      fallback: OpenTofuEncryptionMethod.unencrypted("migrate"),
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
      assume_role = { "role_arn" = "arn:aws:iam::123456789012:role/state" }
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

  const aes = OpenTofuEncryptionMethod.aesGcm("main", {
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
    method: OpenTofuEncryptionMethod.unencrypted("legacy"),
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
        keys: OpenTofuKeyProvider.pbkdf2("chained", {
          chain: passphraseKey(stack),
        }),
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
        OpenTofuKeyProvider.pbkdf2("main", { passphrase });
      new OpenTofuEncryption(stack, "encryption", {
        state: {
          method: OpenTofuEncryptionMethod.aesGcm("state", {
            keys: keys("a"),
          }),
        },
        plan: {
          method: OpenTofuEncryptionMethod.aesGcm("plan", { keys: keys("b") }),
        },
      });
      Testing.fullSynth(stack);
    },
    "OpenTofuEncryption uses two different objects named key_provider.pbkdf2.main.",
  ],
  [
    "a method name that isn't an identifier, since references are written unquoted",
    () => OpenTofuEncryptionMethod.unencrypted("main } evil {"),
    `"main } evil {" isn't a valid OpenTofu encryption type or name.`,
  ],
  [
    "a remote state source without a data source or stack",
    (stack) =>
      new OpenTofuEncryption(stack, "encryption").addRemoteStateSource({
        method: OpenTofuEncryptionMethod.unencrypted("migrate"),
      }),
    "An OpenTofuEncryption remote state source needs exactly one of fromStack and dataSource.",
  ],
])("throws for %s", (_, misuse, error) => {
  const stack = stackTargeting({ opentofu: ">=1.8.0" });

  expect(() => misuse(stack)).toThrow(error);
});
