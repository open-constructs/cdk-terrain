// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AnnotationMetadataEntryType,
  Manifest,
  TerraformStack,
  Testing,
} from "../src";
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

const warnings = (outdir: string): string[] =>
  JSON.parse(fs.readFileSync(path.join(outdir, Manifest.fileName), "utf-8"))
    .stacks.test.annotations.filter(
      (annotation: { level: string }) =>
        annotation.level === AnnotationMetadataEntryType.WARN,
    )
    .map((annotation: { message: string }) => annotation.message);

const requiredVersion = (constraint: string) => ({
  terraform: { required_version: constraint },
});

const stackTargeting = (targetVersions?: TerraformTargetVersions) =>
  new TerraformStack(
    Testing.app({ context: targetVersions && { targetVersions } }),
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

test("writes no OpenTofu settings file when the project doesn't target OpenTofu", () => {
  const outdir = Testing.fullSynth(stackTargeting({ terraform: ">=1.9.0" }));

  expect(readSettingsFile(outdir, "settings.tf.json")).toEqual(
    requiredVersion(">= 1.9.0"),
  );
  expect(readSettingsFile(outdir, "settings.tofu.json")).toBeUndefined();
});

test("writes the OpenTofu range to both settings files when the project doesn't target Terraform", () => {
  const outdir = Testing.fullSynth(stackTargeting({ opentofu: ">=1.9.0" }));

  // OpenTofu 1.6 and 1.7 only read settings.tf.json
  expect(readSettingsFile(outdir, "settings.tf.json")).toEqual(
    requiredVersion(">= 1.9.0"),
  );
  expect(readSettingsFile(outdir, "settings.tofu.json")).toEqual(
    requiredVersion(">= 1.9.0"),
  );
});

test("writes a settings file without required_version for a range that allows every version", () => {
  const outdir = Testing.fullSynth(
    stackTargeting({ terraform: ">=1.5.7", opentofu: "*" }),
  );

  // every OpenTofu release satisfies ">= 1.5.7", so settings.tf.json is still written
  expect(readSettingsFile(outdir, "settings.tf.json")).toEqual(
    requiredVersion(">= 1.5.7"),
  );
  // an empty settings.tofu.json stops OpenTofu 1.8-1.11 from enforcing the Terraform constraint
  expect(readSettingsFile(outdir, "settings.tofu.json")).toEqual({});
});

test("writes no settings files when targetVersions isn't declared", () => {
  const outdir = Testing.fullSynth(stackTargeting());

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
  const targets = { terraform: ">=1.5.7", opentofu: "*" };

  new StackSynthesizer(stackTargeting(targets)).synthesize({
    outdir,
    manifest: new Manifest("stubbed", outdir, false),
  });
  new StackSynthesizer(stackTargeting(targets), false, true).synthesize({
    outdir,
    manifest: new Manifest("stubbed", outdir, true),
  });

  expect(readStackFile(outdir, "settings.tf")).toEqual(
    'terraform {\n  required_version = ">= 1.5.7"\n}\n',
  );
  expect(readStackFile(outdir, "settings.tofu")).toEqual("");
  expect(readStackFile(outdir, "settings.tf.json")).toBeUndefined();
  expect(readStackFile(outdir, "settings.tofu.json")).toBeUndefined();
});

test("warns and skips settings.tf.json for a Terraform range with alternatives", () => {
  const outdir = Testing.fullSynth(
    stackTargeting({ terraform: "1.9.x || 1.11.x", opentofu: ">=1.8.0" }),
  );

  expect(warnings(outdir)).toEqual([
    `targetVersions.terraform "1.9.x || 1.11.x" uses "||", which can't be written as a required_version constraint, so settings.tf.json isn't written.`,
  ]);
  expect(readSettingsFile(outdir, "settings.tf.json")).toBeUndefined();
  expect(readSettingsFile(outdir, "settings.tofu.json")).toEqual(
    requiredVersion(">= 1.8.0"),
  );
});

test("warns and writes settings.tofu.json without required_version for an OpenTofu range with alternatives", () => {
  const outdir = Testing.fullSynth(
    stackTargeting({ terraform: ">=1.5.7", opentofu: "1.9.x || 1.11.x" }),
  );

  expect(warnings(outdir)).toEqual([
    `targetVersions.opentofu "1.9.x || 1.11.x" uses "||", which can't be written as a required_version constraint, so settings.tofu.json is written without one.`,
  ]);
  expect(readSettingsFile(outdir, "settings.tf.json")).toEqual(
    requiredVersion(">= 1.5.7"),
  );
  // an empty settings.tofu.json stops OpenTofu 1.8-1.11 from enforcing the Terraform constraint
  expect(readSettingsFile(outdir, "settings.tofu.json")).toEqual({});
});

test("warns and skips settings.tf.json when the Terraform range rejects targeted OpenTofu releases before 1.8", () => {
  // OpenTofu 1.7 reads settings.tf.json, whose ">= 1.8.0" would reject it
  const outdir = Testing.fullSynth(
    stackTargeting({ terraform: ">=1.8.0", opentofu: ">=1.7.0" }),
  );

  expect(warnings(outdir)).toEqual([
    `targetVersions.opentofu ">=1.7.0" allows OpenTofu releases before 1.8.0, which read settings.tf.json instead of settings.tofu.json, and targetVersions.terraform ">=1.8.0" would reject some of them, so settings.tf.json isn't written. Set targetVersions.opentofu to ">=1.8.0" or narrower to constrain Terraform as well.`,
  ]);
  expect(readSettingsFile(outdir, "settings.tf.json")).toBeUndefined();
  expect(readSettingsFile(outdir, "settings.tofu.json")).toEqual(
    requiredVersion(">= 1.7.0"),
  );
});
