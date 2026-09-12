// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Errors } from "@cdktn/commons";

// The real command modules run against a stubbed handler bundle: nothing is
// executed but the scope assignment the metrics and cli.error counts read.
const handlers = new Proxy(
  {},
  { get: () => jest.fn().mockResolvedValue(undefined) },
);
jest.mock("../helper/utilities", () => ({
  ...jest.requireActual("../helper/utilities"),
  requireHandlers: () => handlers,
}));

import convertCmd from "../convert";
import debugCmd from "../debug";
import deployCmd from "../deploy";
import destroyCmd from "../destroy";
import diffCmd from "../diff";
import getCmd from "../get";
import initCmd from "../init";
import listCmd from "../list";
import loginCmd from "../login";
import outputCmd from "../output";
import providerAddCmd from "../provider-add";
import providerListCmd from "../provider-list";
import providerUpgradeCmd from "../provider-upgrade";
import synthCmd from "../synth";
import watchCmd from "../watch";

type ScopedCommand = { handler: (args: any) => Promise<void> | void };

describe("command scope wiring", () => {
  afterEach(() => {
    Errors.setScope("unknown");
  });

  // without this every metric and error count of the command would report
  // command: "unknown"
  it.each<[string, ScopedCommand]>([
    ["convert", convertCmd],
    ["debug", debugCmd],
    ["deploy", deployCmd],
    ["destroy", destroyCmd],
    ["diff", diffCmd],
    ["get", getCmd],
    ["init", initCmd],
    ["list", listCmd],
    ["login", loginCmd],
    ["output", outputCmd],
    ["provider add", providerAddCmd],
    ["provider list", providerListCmd],
    ["provider upgrade", providerUpgradeCmd],
    ["synth", synthCmd],
    ["watch", watchCmd],
  ])("the %s handler sets the error scope", async (scope, cmd) => {
    await cmd.handler({});

    expect(Errors.getScope()).toBe(scope);
  });
});
