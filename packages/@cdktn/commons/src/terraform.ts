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

// `missing`: the binary could not be spawned; `unknown`: its version output
// was not recognized, or it failed or timed out.
export interface TerraformCliProbe {
  readonly name: TerraformCliName | "missing";
  readonly version?: string;
}

const PROBE_TIMEOUT_MS = 1500;

// The CLI bundle carries several copies of this module (two esbuild entries
// plus the commons build behind the external hcl2cdk); process state keeps it
// to one `version` spawn per process, started on first use.
const probe = processState<{ output?: Promise<string> }>(
  "cdktn.terraformCli",
  () => ({}),
);

/** Test seam: seeds the raw `version` output, or clears it when omitted. */
export function seedTerraformCliProbeForTests(output?: Promise<string>): void {
  probe.output = output;
}

function versionOutput(): Promise<string> {
  if (!probe.output) {
    const output = exec(terraformBinaryName, ["version"], {
      timeout: PROBE_TIMEOUT_MS,
    });
    output.catch(() => undefined); // the consumers below handle rejection
    probe.output = output;
  }
  return probe.output;
}

function toProbe(output: Promise<string>): Promise<TerraformCliProbe> {
  return output
    .then((out) => parseTerraformCliVersion(out))
    .catch((err) => ({
      name:
        err?.code === "ENOENT" ? ("missing" as const) : ("unknown" as const),
    }));
}

/** Binary and version for usage telemetry; never rejects. */
export function terraformCli(): Promise<TerraformCliProbe> {
  return toProbe(versionOutput());
}

/**
 * Like `terraformCli`, but waits for `version` however long it takes, so a
 * check that must not pass unverified never sees a timeout. Not cached.
 */
export function identifyTerraformCli(): Promise<TerraformCliProbe> {
  return toProbe(exec(terraformBinaryName, ["version"], {}));
}

// `undefined` when the probe fails: building an Errors.Usage here would
// count a phantom cli.error.
export function terraformVersion(): Promise<string | undefined> {
  return versionOutput()
    .then((output) => parseTerraformCliVersion(output).version)
    .catch(() => undefined);
}
