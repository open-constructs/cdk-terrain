// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TerraformCli, SynthesizedStack } from "@cdktn/cli-core";
import { Errors, logger, parseTerraformCliVersion } from "@cdktn/commons";
import * as semver from "semver";
import { existsSync } from "fs-extra";
import * as path from "path";

const MIN_SUPPORTED_VERSION = "1.2.0";

export const getTerraformVersion = async (): Promise<string | null> => {
  try {
    // We're abusing the TerraformCli class here,
    // hence we need to construct this object.
    // Only the `workingDirectory` is releveant here.
    const fakeStack: SynthesizedStack = {
      name: "",
      workingDirectory: "./",
      constructPath: "",
      content: "",
      synthesizedStackPath: "",
      stackMetadataPath: "",
      annotations: [],
      dependencies: [],
    };

    const terraform = new TerraformCli(new AbortController().signal, fakeStack);

    const cli = parseTerraformCliVersion(await terraform.version());
    return cli.name === "unknown" ? null : (cli.version ?? null);
  } catch (e) {
    logger.info(`Unable to determine Terraform version: ${e}`);
    return null;
  }
};

// Throws rather than exits so the failure is reported (and counted) once by
// the CLI entrypoint; an undeterminable version only warns.
export const terraformCheck = async (): Promise<void> => {
  if (existsSync(path.join(process.cwd(), "terraform.tfstate"))) {
    throw Errors.Usage(`
        CDK Terrain now supports multiple stacks!
        Found 'terraform.tfstate' Terraform state file. Please rename it to match the stack name. Learn more https://cdktn.io/docs/concepts/stacks#multiple-stacks
      `);
  }
  const cleanTerraformVersion = await getTerraformVersion();

  if (
    cleanTerraformVersion &&
    semver.lt(cleanTerraformVersion, MIN_SUPPORTED_VERSION)
  ) {
    console.warn(
      `Warning: unsupported Terraform version [${cleanTerraformVersion}] - please upgrade to >=${MIN_SUPPORTED_VERSION}`,
    );
  }
};
