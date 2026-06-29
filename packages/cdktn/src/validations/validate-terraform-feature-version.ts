// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

export type TerraformCliName = "terraform" | "opentofu" | "unknown";

export interface TerraformCliVersion {
  readonly name: TerraformCliName;
  readonly version?: string;
}

/**
 * The versions at which Terraform and OpenTofu support a feature, as npm
 * semver ranges. A missing product key means the feature is not supported by
 * that product at any version.
 *
 * Features can become available in Terraform and OpenTofu at different
 * versions, so the validation matrix is feature -> product -> semver range.
 * Used together with the project's declared targets, see
 * ValidateFeatureTargetSupport.
 */
export interface TerraformFeatureVersionConstraints {
  readonly terraform?: string;
  readonly opentofu?: string;
}

/**
 * Parses the output of `terraform version` or `tofu version`.
 *
 * Plain text version output is used because both Terraform and OpenTofu expose
 * a Terraform-compatible `terraform_version` key in `version -json` output.
 *
 * Note: synth-time validations check features against the project's declared
 * `targetVersions` and do not execute any binary; this parser exists for
 * consumers that explicitly interact with an installed CLI (e.g. the opt-in
 * validateInstalledBinary behavior in the cdktn CLI). This is the canonical
 * definition; `@cdktn/commons` imports it (commons depends on cdktn). Its
 * return type uses a string-literal union, so it is kept out of cdktn's
 * public (jsii) API and consumed via subpath import.
 */
export function parseTerraformCliVersion(
  versionOutput: string,
): TerraformCliVersion {
  const firstLine = versionOutput.trim().split(/\r?\n/)[0] || "";
  const firstLineMatch = firstLine.match(
    /^(Terraform|OpenTofu) v(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/,
  );

  if (firstLineMatch) {
    return {
      name: firstLineMatch[1] === "OpenTofu" ? "opentofu" : "terraform",
      version: firstLineMatch[2],
    };
  }

  return {
    name: "unknown",
    version: versionOutput.match(/\d+\.\d+\.\d+(?:[-+][^\s]+)?/)?.[0],
  };
}
