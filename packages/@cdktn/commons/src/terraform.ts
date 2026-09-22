// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { exec } from "./util";
import { processState } from "./process-state";
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

// The CLI bundle carries several copies of this module (two esbuild entries
// plus the commons build behind the external hcl2cdk); process state keeps it
// to one `version` spawn per process, started on first use.
const probe = processState<{ output?: Promise<string> }>(
  "cdktn.terraformCli",
  () => ({}),
);

/**
 * Test seam for the process-global probe: seeds the raw `version` output the
 * parsers see, or clears it when called without an argument.
 */
export function seedTerraformCliProbeForTests(output?: Promise<string>): void {
  probe.output = output;
}

function versionOutput(): Promise<string> {
  if (!probe.output) {
    const output = exec(terraformBinaryName, ["version"], {});
    output.catch(() => undefined); // the consumers below handle rejection
    probe.output = output;
  }
  return probe.output;
}

/** Binary and version for usage telemetry; never rejects. */
export function terraformCli(): Promise<TerraformCliProbe> {
  return versionOutput()
    .then((output) => parseTerraformCliVersion(output))
    .catch(() => ({ name: "missing" as const }));
}

/**
 * Version string for `cdktn debug`; `undefined` when the probe fails, since
 * an `Errors.Usage` value would count a phantom `cli.error`.
 */
export function terraformVersion(): Promise<string | undefined> {
  return versionOutput()
    .then((output) => parseTerraformCliVersion(output).version)
    .catch(() => undefined);
}
