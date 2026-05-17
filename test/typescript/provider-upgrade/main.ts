// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from "constructs";
import { App, TerraformStack, Testing } from "cdktn";
import { AzureadProvider } from "@cdktn/provider-azuread";

export class HelloTerra extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AzureadProvider(this, "provider", {});
  }
}

const app = Testing.stubVersion(new App({ stackTraces: false }));
new HelloTerra(app, "dummy");
app.synth();
