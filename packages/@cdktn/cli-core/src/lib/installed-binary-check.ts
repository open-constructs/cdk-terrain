// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as semver from "semver";
import {
  DEFAULT_TARGET_VERSIONS,
  TerraformCliProbe,
  TerraformTargetVersions,
} from "@cdktn/commons";

/**
 * Verifies that the installed Terraform-compatible binary satisfies the
 * project's declared `targetVersions` (cdktf.json). Only invoked when the
 * project opts in via `validateInstalledBinary: true`, by commands that are
 * about to execute the binary anyway.
 *
 * Declared targets state the project's supported range; this check is the
 * explicit step that proves the local binary actually falls inside it, so a
 * binary it cannot identify fails too.
 */
export function checkInstalledBinaryAgainstTargets(
  cli: TerraformCliProbe,
  declaredTargets: TerraformTargetVersions | undefined,
  binaryName: string,
): string[] {
  const targets = declaredTargets ?? DEFAULT_TARGET_VERSIONS;

  if (cli.name === "missing") {
    return [
      `The binary "${binaryName}" could not be found, so it could not be verified against the declared targetVersions`,
    ];
  }

  if (cli.name === "unknown" || !cli.version) {
    return [
      `Could not determine whether ${binaryName} is Terraform or OpenTofu from its version output, so it could not be verified against the declared targetVersions`,
    ];
  }

  const declaredRange = targets[cli.name];
  if (!declaredRange) {
    return [
      `The installed binary "${binaryName}" is ${cli.name} ${cli.version}, but the project's targetVersions does not declare ${cli.name} (declared: ${JSON.stringify(
        targets,
      )})`,
    ];
  }

  if (!semver.satisfies(cli.version, declaredRange)) {
    return [
      `The installed binary "${binaryName}" is ${cli.name} ${cli.version}, which is outside the project's declared targetVersions.${cli.name} range "${declaredRange}"`,
    ];
  }

  return [];
}
