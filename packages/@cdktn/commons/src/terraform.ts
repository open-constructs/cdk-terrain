// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
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

// The CLI bundle carries several copies of this module (two esbuild entries
// plus the commons build behind the external hcl2cdk); keying the probe on
// globalThis keeps it to one `version` spawn per process, started on first use.
const PROBE_KEY = Symbol.for("cdktn.terraformCli");

/**
 * Test seam for the process-global probe: seeds the raw `version` output the
 * parsers see, or clears it when called without an argument.
 */
export function seedTerraformCliProbeForTests(output?: Promise<string>): void {
  const globals = globalThis as { [PROBE_KEY]?: Promise<string> };
  if (output === undefined) {
    delete globals[PROBE_KEY];
  } else {
    globals[PROBE_KEY] = output;
  }
}

function versionOutput(): Promise<string> {
  const globals = globalThis as { [PROBE_KEY]?: Promise<string> };
  if (!globals[PROBE_KEY]) {
    const output = exec(terraformBinaryName, ["version"], {});
    output.catch(() => undefined); // the consumers below handle rejection
    globals[PROBE_KEY] = output;
  }
  return globals[PROBE_KEY];
}

/** Binary and version for usage telemetry; never rejects. */
export function terraformCli(): Promise<TerraformCliProbe> {
  return versionOutput()
    .then((output) => parseTerraformCliVersion(output))
    .catch(() => ({ name: "missing" as const }));
}

/**
 * Version string for `cdktn debug`; a missing binary resolves to the error
 * text, since an `Errors.Usage` value would count a phantom `cli.error`.
 */
export function terraformVersion(): Promise<string | undefined> {
  return versionOutput()
    .then((output) => parseTerraformCliVersion(output).version)
    .catch(
      (err) =>
        `Error: Usage Error: Unknown: Error loading terraform version ${err}`,
    );
}
