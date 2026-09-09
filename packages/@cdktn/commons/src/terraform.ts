// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Errors } from "./errors";
import { exec } from "./util";
import {
  parseTerraformCliVersion,
  TerraformCliName,
} from "cdktn/lib/validations";

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

/**
 * Outcome of probing the configured Terraform-compatible binary:
 * `missing` when it could not be spawned, `unknown` when its version output
 * was not recognized.
 */
export interface TerraformCliProbe {
  readonly name: TerraformCliName | "missing";
  readonly version?: string;
}

// One `version` spawn per CLI run feeds both the debug output and the
// usage telemetry; plain-text output distinguishes Terraform from OpenTofu.
const versionOutput = exec(terraformBinaryName, ["version"], {});

export const terraformCli: Promise<TerraformCliProbe> = versionOutput
  .then((output) => parseTerraformCliVersion(output))
  .catch(() => ({ name: "missing" as const }));

export const terraformVersion = versionOutput
  .then((output) => parseTerraformCliVersion(output).version)
  .catch((err) =>
    Errors.Usage(`Unknown: Error loading terraform version ${err}`, err),
  );
