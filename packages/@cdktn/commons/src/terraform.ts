// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Errors } from "./errors";
import { exec } from "./util";

export const terraformBinaryName =
  process.env.TERRAFORM_BINARY_NAME || "terraform";

export type TerraformCliProduct = "terraform" | "opentofu" | "unknown";

export interface ParsedTerraformCliVersion {
  readonly name: TerraformCliProduct;
  readonly version?: string;
}

/**
 * Parses the output of `terraform version` / `tofu version` into product and
 * version. Plain text output is used because both Terraform and OpenTofu
 * expose a Terraform-compatible `terraform_version` key in `version -json`
 * output, which makes the JSON output unsuitable for product detection.
 *
 * Mirrors parseTerraformCliVersion in the cdktn package's validations (which
 * cannot be imported here without pulling the whole construct library in).
 */
export function parseTerraformCliVersion(
  versionOutput: string,
): ParsedTerraformCliVersion {
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

export const terraformVersion = exec(
  terraformBinaryName,
  ["version", "-json"],
  {},
)
  .then((versionString) => JSON.parse(versionString).terraform_version)
  .catch((err) =>
    Errors.Usage(`Unknown: Error loading terraform version ${err}`, err),
  );
