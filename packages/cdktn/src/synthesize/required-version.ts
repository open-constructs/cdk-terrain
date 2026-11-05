// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as path from "path";
import * as fs from "fs";
import * as semver from "semver";
import { IConstruct, IValidation } from "constructs";
import { REQUIRED_VERSION_FROM_TARGET_VERSIONS } from "../features";
import {
  resolveTargetVersions,
  TARGET_VERSIONS_CONTEXT_KEY,
  TerraformTargetVersions,
} from "../validations/target-versions";
import { targetVersionsRangeWithAlternatives } from "../errors";

/**
 * Names of the files, in the stack's working directory, that hold each product's `required_version`, in the stack's
 * output format. Terraform reads every `.tf` / `.tf.json` file in the directory and never reads `.tofu` /
 * `.tofu.json` files. OpenTofu 1.8+ loads the OpenTofu file in place of the Terraform file of the same format, and
 * OpenTofu 1.12+ only reads `required_version` from `.tofu` / `.tofu.json` files.
 */
const SETTINGS_FILES: Record<
  "json" | "hcl",
  Record<keyof TerraformTargetVersions, string>
> = {
  json: { terraform: "settings.tf.json", opentofu: "settings.tofu.json" },
  hcl: { terraform: "settings.tf", opentofu: "settings.tofu" },
};

// The first OpenTofu release that loads the OpenTofu settings file in place of the Terraform one
const OPENTOFU_TOFU_FILES_SINCE = "1.8.0";

/**
 * Checks whether `required_version` should be written from `targetVersions` for the given scope: the feature flag is
 * on and `targetVersions` is declared, rather than falling back to the defaults.
 * @param scope - construct whose context is read, usually a stack
 * @returns true if the settings files should be written
 */
export function writesRequiredVersion(scope: IConstruct): boolean {
  return (
    !!scope.node.tryGetContext(REQUIRED_VERSION_FROM_TARGET_VERSIONS) &&
    scope.node.tryGetContext(TARGET_VERSIONS_CONTEXT_KEY) !== undefined
  );
}

/**
 * Converts an npm semver range into a Terraform version constraint, e.g. `^1.8.0` into `>= 1.8.0, < 2.0.0`. npm
 * normalises every range into comparators that Terraform's syntax can express, except alternatives (`||`).
 * @param range - a valid npm semver range
 * @returns the Terraform version constraint, or `undefined` when the range allows every version
 * @throws if the range has alternatives (`||`)
 */
export function toTerraformConstraint(range: string): string | undefined {
  const comparatorSets = new semver.Range(range).set;
  if (comparatorSets.length > 1) {
    throw targetVersionsRangeWithAlternatives(range);
  }

  const constraints = comparatorSets[0]
    .filter((comparator) => comparator.value !== "") // "*" normalises to a comparator that matches any version
    .map(
      (comparator) =>
        `${comparator.operator || "="} ${constraintVersion(comparator)}`,
    );
  return constraints.length > 0 ? constraints.join(", ") : undefined;
}

/**
 * Renders a comparator's version for a Terraform constraint. npm writes upper bounds as `<2.0.0-0` so that
 * prereleases of 2.0.0 are excluded; Terraform's `< 2.0.0` already excludes them, since Terraform only matches a
 * prerelease when the constraint names one.
 * @param comparator - one comparator of a normalised npm range
 * @returns the version to write after the operator
 */
function constraintVersion(comparator: semver.Comparator): string {
  const version = comparator.semver;
  const isUpperBoundSentinel =
    comparator.operator === "<" &&
    version.prerelease.length === 1 &&
    version.prerelease[0] === 0;
  return isUpperBoundSentinel
    ? `${version.major}.${version.minor}.${version.patch}`
    : version.version;
}

/**
 * Validates that the project's `targetVersions` can be written as `required_version` constraints. Added to a stack
 * only when {@link writesRequiredVersion} is true.
 */
export class ValidateRequiredVersionTargets implements IValidation {
  /**
   * @param scope - construct whose `targetVersions` context is validated, usually a stack
   * @param hclOutput - whether the stack is synthesized as HCL, which names the settings files in the error message
   */
  constructor(
    private readonly scope: IConstruct,
    private readonly hclOutput: boolean,
  ) {}

  /**
   * Fails for ranges with alternatives (`||`), and for an OpenTofu range that allows releases before 1.8 that the
   * Terraform constraint would reject: those releases read the Terraform settings file, not the OpenTofu one.
   * @returns the validation errors, empty when the targets can be written
   */
  public validate(): string[] {
    const { targets, errors } = resolveTargetVersions(this.scope);
    if (!targets) {
      return errors;
    }

    const withAlternatives = Object.values(targets).filter(
      (range) => new semver.Range(range).set.length > 1,
    );
    if (withAlternatives.length > 0) {
      return withAlternatives.map(
        (range) => targetVersionsRangeWithAlternatives(range).message,
      );
    }

    if (targets.terraform && targets.opentofu) {
      const opentofuReadingTfFiles = `${
        new semver.Range(targets.opentofu).range
      } <${OPENTOFU_TOFU_FILES_SINCE}`;
      if (!semver.subset(opentofuReadingTfFiles, targets.terraform)) {
        const files = SETTINGS_FILES[this.hclOutput ? "hcl" : "json"];
        return [
          `targetVersions.opentofu "${targets.opentofu}" allows OpenTofu releases before ${OPENTOFU_TOFU_FILES_SINCE}, which read ${files.terraform} instead of ${files.opentofu}, and targetVersions.terraform "${targets.terraform}" would reject some of them. Set targetVersions.opentofu to ">=${OPENTOFU_TOFU_FILES_SINCE}" or narrower, or widen targetVersions.terraform to include them.`,
        ];
      }
    }

    return [];
  }
}

/**
 * Writes the settings file for each product in `targetVersions` into the stack's working directory, in the stack's
 * output format. A product that isn't targeted gets no file, and a product whose range allows every version gets a
 * file without `required_version` so that OpenTofu doesn't fall back to the Terraform constraint.
 * @param scope - construct whose `targetVersions` context is read, usually a stack
 * @param workingDirectory - absolute path of the stack's working directory
 * @param hclOutput - whether to write `settings.tf` / `settings.tofu` instead of `settings.tf.json` /
 * `settings.tofu.json`
 */
export function writeRequiredVersionFiles(
  scope: IConstruct,
  workingDirectory: string,
  hclOutput: boolean,
): void {
  const { targets } = resolveTargetVersions(scope);
  if (!targets) {
    return;
  }

  const files = SETTINGS_FILES[hclOutput ? "hcl" : "json"];
  for (const [product, file] of Object.entries(files)) {
    const range = targets[product as keyof TerraformTargetVersions];
    if (range === undefined) {
      continue;
    }

    const requiredVersion = toTerraformConstraint(range);
    fs.writeFileSync(
      path.join(workingDirectory, file),
      hclOutput
        ? renderHclSettings(requiredVersion)
        : renderJsonSettings(requiredVersion),
    );
  }
}

/**
 * Renders a settings file as Terraform JSON configuration.
 * @param requiredVersion - the Terraform version constraint, or `undefined` for an empty configuration
 * @returns the file's content
 */
function renderJsonSettings(requiredVersion: string | undefined): string {
  const content =
    requiredVersion === undefined
      ? {}
      : { terraform: { required_version: requiredVersion } };
  return JSON.stringify(content, null, 2);
}

/**
 * Renders a settings file as HCL.
 * @param requiredVersion - the Terraform version constraint, or `undefined` for an empty configuration
 * @returns the file's content
 */
function renderHclSettings(requiredVersion: string | undefined): string {
  // a constraint holds only operators, versions, commas and spaces, so a JSON string literal is a valid HCL one
  return requiredVersion === undefined
    ? ""
    : `terraform {\n  required_version = ${JSON.stringify(requiredVersion)}\n}\n`;
}

/**
 * Removes the settings files, in either format, written by a previous synth, so they don't outlive a change to
 * `targetVersions`, the feature flag or the output format.
 * @param workingDirectory - absolute path of the stack's working directory
 */
export function removeRequiredVersionFiles(workingDirectory: string): void {
  for (const files of Object.values(SETTINGS_FILES)) {
    for (const file of Object.values(files)) {
      fs.rmSync(path.join(workingDirectory, file), { force: true });
    }
  }
}
