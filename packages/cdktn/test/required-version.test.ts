// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { App, Manifest, TerraformStack, Testing } from "../src";
import { StackSynthesizer } from "../src/synthesize/synthesizer";
import { TerraformTargetVersions } from "../src/validations/target-versions";

const readStackFile = (outdir: string, file: string) => {
  const filePath = path.join(outdir, "stacks", "test", file);
  return fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : undefined;
};

const readSettingsFile = (outdir: string, file: string) => {
  const content = readStackFile(outdir, file);
  return content === undefined ? undefined : JSON.parse(content);
};

const requiredVersion = (constraint: string) => ({
  terraform: { required_version: constraint },
});

// Testing.app enables every future flag, including requiredVersionFromTargetVersions
const stackTargeting = (targetVersions?: TerraformTargetVersions, app?: App) =>
  new TerraformStack(
    app ?? Testing.app({ context: targetVersions && { targetVersions } }),
    "test",
  );

test.each([
  [">=1.5.7", ">= 1.5.7"],
  ["^1.8.0", ">= 1.8.0, < 2.0.0"],
  ["~1.9.2", ">= 1.9.2, < 1.10.0"],
  ["1.10.3", "= 1.10.3"],
  [">=1.9.0-beta1 <1.11.0", ">= 1.9.0-beta1, < 1.11.0"],
])(
  "writes targetVersions range %s as required_version %s",
  (range, constraint) => {
    const outdir = Testing.fullSynth(stackTargeting({ terraform: range }));

    expect(readSettingsFile(outdir, "settings.tf.json")).toEqual(
      requiredVersion(constraint),
    );
  },
);

test("writes each targeted product's range to its own settings file", () => {
  const outdir = Testing.fullSynth(
    stackTargeting({ terraform: ">=1.5.7", opentofu: ">=1.6.0" }),
  );

  expect(readSettingsFile(outdir, "settings.tf.json")).toEqual(
    requiredVersion(">= 1.5.7"),
  );
  expect(readSettingsFile(outdir, "settings.tofu.json")).toEqual(
    requiredVersion(">= 1.6.0"),
  );
});

test("writes no settings file for a product the project doesn't target", () => {
  const outdir = Testing.fullSynth(stackTargeting({ opentofu: ">=1.8.0" }));

  expect(readSettingsFile(outdir, "settings.tf.json")).toBeUndefined();
  expect(readSettingsFile(outdir, "settings.tofu.json")).toEqual(
    requiredVersion(">= 1.8.0"),
  );
});

test("writes a settings file without required_version for a range that allows every version", () => {
  const outdir = Testing.fullSynth(
    stackTargeting({ terraform: ">=1.9.0", opentofu: "*" }),
  );

  // an empty settings.tofu.json stops OpenTofu 1.8-1.11 from enforcing the Terraform constraint
  expect(readSettingsFile(outdir, "settings.tofu.json")).toEqual({});
});

test("writes no settings files when targetVersions isn't declared", () => {
  const outdir = Testing.fullSynth(stackTargeting());

  expect(readSettingsFile(outdir, "settings.tf.json")).toBeUndefined();
  expect(readSettingsFile(outdir, "settings.tofu.json")).toBeUndefined();
});

test("writes no settings files when the feature flag is disabled", () => {
  const app = Testing.app({
    enableFutureFlags: false,
    context: { targetVersions: { terraform: ">=1.5.7", opentofu: ">=1.6.0" } },
  });
  const outdir = Testing.fullSynth(stackTargeting(undefined, app));

  expect(readSettingsFile(outdir, "settings.tf.json")).toBeUndefined();
  expect(readSettingsFile(outdir, "settings.tofu.json")).toBeUndefined();
});

test("removes settings files from a previous synth that no longer apply", () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktf.outdir."));
  const synthInto = (stack: TerraformStack) =>
    stack.synthesizer.synthesize({
      outdir,
      manifest: new Manifest("stubbed", outdir, false),
    });

  synthInto(stackTargeting({ terraform: ">=1.5.7", opentofu: ">=1.6.0" }));
  synthInto(stackTargeting({ terraform: ">=1.5.7" }));

  expect(readSettingsFile(outdir, "settings.tf.json")).toEqual(
    requiredVersion(">= 1.5.7"),
  );
  expect(readSettingsFile(outdir, "settings.tofu.json")).toBeUndefined();
});

test("writes HCL settings files with HCL output, replacing JSON ones from a previous synth", () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktf.outdir."));
  const targets = { terraform: "^1.9.0", opentofu: "*" };

  new StackSynthesizer(stackTargeting(targets)).synthesize({
    outdir,
    manifest: new Manifest("stubbed", outdir, false),
  });
  new StackSynthesizer(stackTargeting(targets), false, true).synthesize({
    outdir,
    manifest: new Manifest("stubbed", outdir, true),
  });

  expect(readStackFile(outdir, "settings.tf")).toEqual(
    'terraform {\n  required_version = ">= 1.9.0, < 2.0.0"\n}\n',
  );
  expect(readStackFile(outdir, "settings.tofu")).toEqual("");
  expect(readStackFile(outdir, "settings.tf.json")).toBeUndefined();
  expect(readStackFile(outdir, "settings.tofu.json")).toBeUndefined();
});

test("fails synth for a range with alternatives", () => {
  const stack = stackTargeting({ terraform: "1.9.x || 1.11.x" });

  expect(() => Testing.fullSynth(stack)).toThrow(
    `targetVersions range "1.9.x || 1.11.x" uses "||", which can't be written as a required_version constraint.`,
  );
});

test("fails synth when the Terraform range rejects targeted OpenTofu releases before 1.8", () => {
  // OpenTofu 1.7 reads settings.tf.json, whose ">= 1.8.0" rejects it
  const stack = stackTargeting({ terraform: ">=1.8.0", opentofu: ">=1.7.0" });

  expect(() => Testing.fullSynth(stack)).toThrow(
    `targetVersions.opentofu ">=1.7.0" allows OpenTofu releases before 1.8.0, which read settings.tf.json instead of settings.tofu.json, and targetVersions.terraform ">=1.8.0" would reject some of them.`,
  );
});
