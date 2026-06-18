// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import type { Construct } from "constructs";
import { App, TerraformStack, Testing } from "cdktn";

import { provider } from "./.gen/providers/null/index.ts";

export class Empty extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new provider.NullProvider(this, "null", {});
  }
}

const app = Testing.stubVersion(new App({ stackTraces: false }));
new Empty(app, "esm");
app.synth();
