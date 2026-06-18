// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { IValidation } from "constructs";
import { execSync } from "child_process";
import * as semver from "semver";
import { terraformBinaryName } from "../util";

export type TerraformCliName = "terraform" | "opentofu" | "unknown";

export interface TerraformCliVersion {
  readonly name: TerraformCliName;
  readonly version?: string;
}

export interface TerraformFeatureVersionConstraints {
  readonly terraform?: string;
  readonly opentofu?: string;
}

/**
 * Parses the output of `terraform version` or `tofu version`.
 *
 * Plain text version output is used because both Terraform and OpenTofu expose
 * a Terraform-compatible `terraform_version` key in `version -json` output.
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

/**
 * Validates whether the selected Terraform-compatible CLI supports a feature.
 *
 * A feature can become available in Terraform and OpenTofu at different
 * versions, so the validation matrix is feature -> CLI product -> semver range.
 */
export class ValidateTerraformFeatureVersion implements IValidation {
  constructor(
    protected featureName: string,
    protected constraints: TerraformFeatureVersionConstraints,
    protected versionCommand: string = `${terraformBinaryName} version`,
    protected binary: string = terraformBinaryName,
    protected hint?: string,
  ) {}

  public validate() {
    try {
      const versionOutput = execSync(this.versionCommand, {
        stdio: "pipe",
      }).toString();
      const firstLine = versionOutput.trim().split(/\r?\n/)[0] || "";
      const cliVersion = parseTerraformCliVersion(versionOutput);

      if (cliVersion.name === "unknown") {
        return [
          `Could not determine whether ${this.binary} is Terraform or OpenTofu from the first line of ${this.binary} version output: ${firstLine}`,
        ];
      }

      if (!cliVersion.version) {
        return [
          `Could not determine version of ${this.binary} (running ${this.versionCommand})`,
        ];
      }

      const constraint = this.constraints[cliVersion.name];
      if (!constraint) {
        return [
          `${this.featureName} is not supported by ${cliVersion.name}. ${
            this.hint || ""
          }`,
        ];
      }

      if (!semver.satisfies(cliVersion.version, constraint)) {
        return [
          `${this.featureName} requires ${cliVersion.name} ${constraint}, but ${cliVersion.name} version ${cliVersion.version} was found. ${
            this.hint || ""
          }`.trimEnd(),
        ];
      }

      return [];
    } catch (e) {
      return [
        `Could not determine version of ${this.binary}, ${this.versionCommand} failed: ${e}`,
      ];
    }
  }
}
