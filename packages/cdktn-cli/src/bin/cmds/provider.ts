// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import yargs from "yargs";
import getCmd from "./get";
import providerAddCmd from "./provider-add";
import providerUpgradeCmd from "./provider-upgrade";
import providerListCmd from "./provider-list";

class Command implements yargs.CommandModule {
  public readonly command = "provider";
  public readonly describe =
    "A set of subcommands that facilitates provider management";

  public readonly builder = (args: yargs.Argv) =>
    args
      .command(getCmd)
      .command(providerAddCmd)
      .command(providerUpgradeCmd)
      .command(providerListCmd);

  public readonly handler = () => {
    yargs.showHelp();
  };
}

export default new Command();
