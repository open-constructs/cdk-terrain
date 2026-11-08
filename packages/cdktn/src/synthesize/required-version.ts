// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as path from "path";
import * as fs from "fs";
import * as semver from "semver";
import { IConstruct } from "constructs";
import { Annotations } from "../annotations";
import {
  resolveTargetVersions,
  TARGET_VERSIONS_CONTEXT_KEY,
  TerraformTargetVersions,
} from "../validations/target-versions";

type Product = keyof TerraformTargetVersions;

/**
 * Names of the files, in the stack's working directory, that hold each product's `required_version`, in the stack's
 * output format. Terraform reads every `.tf` / `.tf.json` file in the directory and never reads `.tofu` /
 * `.tofu.json` files. OpenTofu 1.8+ loads the OpenTofu file in place of the Terraform file of the same format, and
 * OpenTofu 1.12+ only reads `required_version` from `.tofu` / `.tofu.json` files.
 */
const SETTINGS_FILES: Record<"json" | "hcl", Record<Product, string>> = {
  json: { terraform: "settings.tf.json", opentofu: "settings.tofu.json" },
  hcl: { terraform: "settings.tf", opentofu: "settings.tofu" },
};

// The first OpenTofu release
const OPENTOFU_FIRST_RELEASE = "1.6.0";

// The first OpenTofu release that loads the OpenTofu settings file in place of the Terraform one
const OPENTOFU_TOFU_FILES_SINCE = "1.8.0";

/**
 * Checks whether `required_version` should be written from `targetVersions` for the given scope: `targetVersions` is
 * declared, rather than falling back to the defaults.
 * @param scope - construct whose context is read, usually a stack
 * @returns true if the settings files should be written
 */
export function writesRequiredVersion(scope: IConstruct): boolean {
  return scope.node.tryGetContext(TARGET_VERSIONS_CONTEXT_KEY) !== undefined;
}

/**
 * Converts one comparator set of a normalised npm range into a Terraform version constraint, e.g. the set for `^1.8.0`
 * into `>= 1.8.0, < 2.0.0`. Terraform's syntax can express any single comparator set, but not alternatives (`||`).
 * @param comparators - the comparators of a range without alternatives
 * @returns the Terraform version constraint, or `undefined` when the comparators allow every version
 */
function toTerraformConstraint(
  comparators: readonly semver.Comparator[],
): string | undefined {
  const constraints = comparators
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
 * Narrows an OpenTofu range to the released versions that read the Terraform settings file: 1.6 and 1.7.
 * @param opentofu - the project's OpenTofu range
 * @returns an npm range of the targeted OpenTofu releases that don't load the OpenTofu settings file
 */
function opentofuReadingTerraformFile(opentofu: string): string {
  return new semver.Range(opentofu).set
    .map((comparators) =>
      [
        ...comparators.map((comparator) => comparator.value),
        `>=${OPENTOFU_FIRST_RELEASE}`,
        `<${OPENTOFU_TOFU_FILES_SINCE}`,
      ].join(" "),
    )
    .join(" || ");
}

/**
 * Writes a settings file for each product in `targetVersions` into the stack's working directory, in the stack's
 * output format:
 *
 * - A product that isn't targeted gets no file, except that an OpenTofu-only project also writes its OpenTofu
 *   constraint to the Terraform file, which OpenTofu 1.6 and 1.7 read in place of the OpenTofu file.
 * - A product whose range allows every version gets a file without `required_version`, so that OpenTofu doesn't
 *   fall back to the Terraform constraint.
 * - A range with alternatives (`||`) can't be written as a constraint. It adds a warning, and the Terraform file is
 *   skipped, or the OpenTofu file is written without `required_version`.
 * - If targeted OpenTofu releases before 1.8 would be rejected by the Terraform constraint, it adds a warning and
 *   skips the Terraform file.
 * @param scope - construct whose `targetVersions` context is read and that receives warnings, usually a stack
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
  const { terraform, opentofu } = targets;
  const warnAboutAlternatives = (
    product: Product,
    range: string,
    outcome: string,
  ) =>
    Annotations.of(scope).addWarning(
      `targetVersions.${product} "${range}" uses "||", which can't be written as a required_version constraint, so ${files[product]} ${outcome}.`,
    );

  // the constraint to write for each file; a file with an undefined constraint is written without required_version
  const constraints = new Map<Product, string | undefined>();

  if (opentofu !== undefined) {
    const comparatorSets = new semver.Range(opentofu).set;
    if (comparatorSets.length > 1) {
      warnAboutAlternatives("opentofu", opentofu, "is written without one");
      constraints.set("opentofu", undefined);
    } else {
      constraints.set("opentofu", toTerraformConstraint(comparatorSets[0]));
    }
  }

  if (terraform !== undefined) {
    const comparatorSets = new semver.Range(terraform).set;
    if (comparatorSets.length > 1) {
      warnAboutAlternatives("terraform", terraform, "isn't written");
    } else if (
      opentofu !== undefined &&
      !semver.subset(opentofuReadingTerraformFile(opentofu), terraform)
    ) {
      Annotations.of(scope).addWarning(
        `targetVersions.opentofu "${opentofu}" allows OpenTofu releases before ${OPENTOFU_TOFU_FILES_SINCE}, which read ${files.terraform} instead of ${files.opentofu}, and targetVersions.terraform "${terraform}" would reject some of them, so ${files.terraform} isn't written. Set targetVersions.opentofu to ">=${OPENTOFU_TOFU_FILES_SINCE}" or narrower to constrain Terraform as well.`,
      );
    } else {
      constraints.set("terraform", toTerraformConstraint(comparatorSets[0]));
    }
  } else if (constraints.get("opentofu") !== undefined) {
    // Terraform isn't targeted, so the Terraform file can carry the OpenTofu constraint for OpenTofu 1.6 and 1.7
    constraints.set("terraform", constraints.get("opentofu"));
  }

  for (const [product, requiredVersion] of constraints) {
    fs.writeFileSync(
      path.join(workingDirectory, files[product]),
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
 * `targetVersions` or the output format.
 * @param workingDirectory - absolute path of the stack's working directory
 */
export function removeRequiredVersionFiles(workingDirectory: string): void {
  for (const files of Object.values(SETTINGS_FILES)) {
    for (const file of Object.values(files)) {
      fs.rmSync(path.join(workingDirectory, file), { force: true });
    }
  }
}
