// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  App,
  AnnotationMetadataEntryType,
  Manifest,
  OpenTofuEncryption,
  TerraformStack,
  TerraformVariable,
  Testing,
} from "../src";
import { TerraformTargetVersions } from "../src/validations/target-versions";

const readStackFile = (outdir: string, file: string) => {
  const filePath = path.join(outdir, "stacks", "test", file);
  return fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : undefined;
};

const readJson = (outdir: string, file: string) => {
  const content = readStackFile(outdir, file);
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

// a passphrase from a variable, aes_gcm, and an unencrypted fallback for migrating existing state
const encryptWithPassphrase = (stack: TerraformStack) => {
  const passphrase = new TerraformVariable(stack, "state_passphrase", {
    type: "string",
    sensitive: true,
  });
  const encryption = new OpenTofuEncryption(stack, "encryption");
  const key = encryption.addKeyProvider("pbkdf2", "main", {
    passphrase: passphrase.stringValue,
  });
  const aes = encryption.addMethod("aes_gcm", "main", { keys: key });
  const migrate = encryption.addMethod("unencrypted", "migrate");
  encryption.encryptState({ method: aes, fallback: migrate });
  encryption.encryptPlan({ method: aes, enforced: true });
  encryption.encryptRemoteStateDataSources({ method: aes });
  return encryption;
};

test("writes the encryption block to settings.tofu.json only, with bare references to key providers and methods", () => {
  const stack = stackTargeting({ opentofu: ">=1.8.0" });
  encryptWithPassphrase(stack);

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
    context: { targetVersions: { opentofu: ">=1.8.0" } },
  });
  const encryption = encryptWithPassphrase(new TerraformStack(app, "test"));
  // assume_role is an attribute; OpenTofu rejects it as a block
  encryption.addKeyProvider("aws_kms", "kms", {
    kms_key_id: "alias/state",
    assume_role: { role_arn: "arn:aws:iam::123456789012:role/state" },
  });

  app.synth();

  expect(readStackFile(outdir, "settings.tofu")).toEqual(`terraform {
  required_version = ">= 1.8.0"
  encryption {
    key_provider "pbkdf2" "main" {
      passphrase = "\${var.state_passphrase}"
    }
    key_provider "aws_kms" "kms" {
      kms_key_id = "alias/state"
      assume_role = { "role_arn" = "arn:aws:iam::123456789012:role/state" }
    }
    method "aes_gcm" "main" {
      keys = key_provider.pbkdf2.main
    }
    method "unencrypted" "migrate" {}
    state {
      method = method.aes_gcm.main
      fallback {
        method = method.unencrypted.migrate
      }
    }
    plan {
      method = method.aes_gcm.main
      enforced = true
    }
    remote_state_data_sources {
      default {
        method = method.aes_gcm.main
      }
    }
  }
}
`);
  expect(readStackFile(outdir, "settings.tf")).toEqual(
    'terraform {\n  required_version = ">= 1.8.0"\n}\n',
  );
});

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

test.each<[string, TerraformTargetVersions | undefined, string]>([
  [
    "targetVersions isn't declared",
    undefined,
    `OpenTofu encryption requires opentofu >=1.8.0, but the project targets opentofu >=1.6.0. OpenTofu 1.7 doesn't read settings.tofu.json, where cdktn writes the encryption block. Set targetVersions.opentofu to ">=1.8.0" or narrower.`,
  ],
  [
    "the OpenTofu range allows 1.7, which doesn't read settings.tofu.json",
    { opentofu: ">=1.7.0" },
    `OpenTofu encryption requires opentofu >=1.8.0, but the project targets opentofu >=1.7.0.`,
  ],
  [
    "the project doesn't target OpenTofu",
    { terraform: ">=1.5.7" },
    `OpenTofu encryption is only supported by OpenTofu, but the project doesn't target it. Set targetVersions.opentofu to ">=1.8.0" or narrower.`,
  ],
])("fails synth when %s", (_, targetVersions, error) => {
  const stack = stackTargeting(targetVersions);
  encryptWithPassphrase(stack);

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
    "a key provider declared twice",
    (stack) => {
      const encryption = new OpenTofuEncryption(stack, "encryption");
      encryption.addKeyProvider("pbkdf2", "main");
      encryption.addKeyProvider("pbkdf2", "main");
    },
    "OpenTofuEncryption already declares key_provider.pbkdf2.main.",
  ],
  [
    "a method name that isn't an identifier, since references are written unquoted",
    (stack) => {
      new OpenTofuEncryption(stack, "encryption").encryptState({
        method: { type: "aes_gcm", name: "main } evil {" },
      });
    },
    `"main } evil {" isn't a valid OpenTofu encryption type or name.`,
  ],
])("throws for %s", (_, misuse, error) => {
  const stack = stackTargeting({ opentofu: ">=1.8.0" });

  expect(() => misuse(stack)).toThrow(error);
});
