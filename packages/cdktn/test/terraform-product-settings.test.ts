// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Manifest,
  TerraformProductSettings,
  TerraformStack,
  Testing,
} from "../src";

const readSettingsFile = (outdir: string, file: string) => {
  const filePath = path.join(outdir, "stacks", "test", file);
  return fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
    : undefined;
};

const synthInto = (outdir: string, stack: TerraformStack) =>
  stack.synthesizer.synthesize({
    outdir,
    manifest: new Manifest("stubbed", outdir, false),
  });

// OpenTofu only reads settings.tofu.json from 1.8, below the default target of >=1.6.0
const appTargetingTofu18 = () =>
  Testing.app({ context: { targetVersions: { opentofu: ">=1.8.0" } } });

const tf = { terraform: { required_version: "~> 1.9" } };
const tofu = { terraform: { required_version: "~> 1.8" } };

test.each([
  [
    "both products",
    {
      terraform: { requiredVersion: "~> 1.9" },
      opentofu: { requiredVersion: "~> 1.8" },
    },
    tf,
    tofu,
  ],
  [
    "terraform only",
    { terraform: { requiredVersion: "~> 1.9" } },
    tf,
    undefined,
  ],
  [
    "opentofu only",
    { opentofu: { requiredVersion: "~> 1.8" } },
    undefined,
    tofu,
  ],
])(
  "%s: writes settings.tf.json and settings.tofu.json",
  (_, config, expectedTf, expectedTofu) => {
    const stack = new TerraformStack(appTargetingTofu18(), "test");
    new TerraformProductSettings(stack, "settings", config);

    const outdir = Testing.fullSynth(stack);

    expect(readSettingsFile(outdir, "settings.tf.json")).toEqual(expectedTf);
    expect(readSettingsFile(outdir, "settings.tofu.json")).toEqual(
      expectedTofu,
    );
  },
);

test("settings files from a previous synth are removed once the construct is gone", () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktf.outdir."));

  const before = new TerraformStack(appTargetingTofu18(), "test");
  new TerraformProductSettings(before, "settings", {
    terraform: { requiredVersion: "~> 1.9" },
    opentofu: { requiredVersion: "~> 1.8" },
  });
  synthInto(outdir, before);

  synthInto(outdir, new TerraformStack(Testing.app(), "test"));

  expect(readSettingsFile(outdir, "settings.tf.json")).toBeUndefined();
  expect(readSettingsFile(outdir, "settings.tofu.json")).toBeUndefined();
});

test("fails synth when OpenTofu settings are set and the project targets OpenTofu below 1.8", () => {
  const stack = new TerraformStack(Testing.app(), "test");
  new TerraformProductSettings(stack, "settings", {
    opentofu: { requiredVersion: "~> 1.8" },
  });

  expect(() => Testing.fullSynth(stack)).toThrow(
    /TerraformProductSettings requires opentofu >=1\.8\.0, but the project targets opentofu >=1\.6\.0\. Set targetVersions\.opentofu/,
  );
});

test("Terraform-only settings synth with the default OpenTofu target", () => {
  const stack = new TerraformStack(Testing.app(), "test");
  new TerraformProductSettings(stack, "settings", {
    terraform: { requiredVersion: "~> 1.9" },
  });

  expect(() => Testing.fullSynth(stack)).not.toThrow();
});

test("requires at least one product", () => {
  const stack = new TerraformStack(Testing.app(), "test");

  expect(() => new TerraformProductSettings(stack, "settings", {})).toThrow(
    /at least one of 'terraform' or 'opentofu'/,
  );
});

test("requires each product to set at least one setting", () => {
  const stack = new TerraformStack(Testing.app(), "test");

  expect(
    () =>
      new TerraformProductSettings(stack, "settings", {
        terraform: { requiredVersion: "~> 1.9" },
        opentofu: {},
      }),
  ).toThrow(/sets 'opentofu' without any settings/);
});

test("allows only one per stack", () => {
  const stack = new TerraformStack(Testing.app(), "test");
  new TerraformProductSettings(stack, "first", {
    terraform: { requiredVersion: "~> 1.9" },
  });

  expect(
    () =>
      new TerraformProductSettings(stack, "second", {
        opentofu: { requiredVersion: "~> 1.8" },
      }),
  ).toThrow(/already has a TerraformProductSettings at 'test\/first'/);
});
