// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Errors } from "./errors";
import { exec } from "./util";

export const terraformBinaryName =
  process.env.TERRAFORM_BINARY_NAME || "terraform";

// The Terraform CLI version parser lives in the cdktn package (its canonical
// home). It is consumed via subpath because its string-literal union return
// type is not part of cdktn's public jsii API. Re-exported here so existing
// commons consumers (e.g. @cdktn/cli-core) keep a single import surface.
export { parseTerraformCliVersion } from "cdktn/lib/validations";
export type {
  TerraformCliVersion,
  TerraformCliName,
} from "cdktn/lib/validations";

export const terraformVersion = exec(
  terraformBinaryName,
  ["version", "-json"],
  {},
)
  .then((versionString) => JSON.parse(versionString).terraform_version)
  .catch((err) =>
    Errors.Usage(`Unknown: Error loading terraform version ${err}`, err),
  );
