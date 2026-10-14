// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import yargs from "yargs";

import { readPackageJson, requireHandlers } from "./helper/utilities";
import { Errors, logger } from "@cdktn/commons";
import { BaseCommand } from "./helper/base-command";

const pkg = readPackageJson();

// yargs only renders `deprecated` in help, so the notice is printed here. The
// canonical option carries no yargs default so that an explicit value can be
// told apart from the fallback.
function applyDeprecatedCdktfVersion(argv: Record<string, any>) {
  if (argv["cdktf-version"] !== undefined) {
    logger.warn(
      "WARNING: --cdktf-version is deprecated and will be removed in a future release. Use --cdktn-version instead.",
    );
  }
  const version = argv["cdktn-version"] ?? argv["cdktf-version"] ?? pkg.version;
  argv["cdktn-version"] = version;
  argv.cdktnVersion = version;
}

class Command extends BaseCommand {
  public readonly command = "init";
  public readonly describe = "Create a new cdktn project from a template.";
  public readonly builder = (args: yargs.Argv) =>
    args
      .showHelpOnFail(true)
      .option("template", {
        type: "string",
        desc: `The template to be used to create a new project. Either URL to zip file or one of the built-in templates.`,
      })
      .option("project-name", {
        type: "string",
        desc: "The name of the project.",
      })
      .option("project-description", {
        type: "string",
        desc: "The description of the project.",
      })
      .option("dist", {
        type: "string",
        desc: 'Install dependencies from a "dist" directory (for development)',
      })
      .option("local", {
        type: "boolean",
        desc: "Use local state storage for generated Terraform.",
        default: false,
      })
      .option("cdktn-version", {
        type: "string",
        desc: "The cdktn version to use while creating a new project.",
        defaultDescription: pkg.version,
      })
      .option("cdktf-version", {
        type: "string",
        desc: "Deprecated alias of --cdktn-version.",
        deprecated:
          "Use --cdktn-version instead; --cdktf-version will be removed in a future release.",
      })
      .middleware(applyDeprecatedCdktfVersion)
      .option("from-terraform-project", {
        type: "string",
        desc: "Use a terraform project as the basis, CDK constructs will be generated based on the .tf files in the path",
      })
      .option("enable-crash-reporting", {
        type: "boolean",
        desc: "Enable crash reporting for the CLI, refer to https://cdktn.io/docs/telemetry#crash-reporting for more details",
      })
      .option("enable-usage-telemetry", {
        type: "boolean",
        desc: "Enable anonymous usage telemetry for the CLI (never your code, paths or resource names), refer to https://cdktn.io/docs/telemetry for more details",
      })
      .option("providers", {
        describe: "Providers to add to your project",
        type: "array",
        default: [],
      })
      .option("providers-force-local", {
        type: "boolean",
        desc: "Force local installation of provider specified in init",
      })
      .option("tfe-hostname", {
        type: "string",
        desc: "The hostname of the Terraform Enterprise instance to use for remote state storage",
      })
      .strict();

  public async handleCommand(argv: any) {
    Errors.setScope("init");
    // deferred require to keep cdktn-cli main entrypoint small (e.g. for fast shell completions)
    const api = requireHandlers();
    await api.init(argv);
  }
}

export default new Command();
