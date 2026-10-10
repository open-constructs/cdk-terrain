// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from "constructs";
import { App, TerraformOutput, TerraformStack, Testing } from "cdktn";
import { RandomProvider } from "./.gen/providers/random/provider";
import { Id } from "./.gen/providers/random/id";

export class OpenTofuTarget extends TerraformStack {
  constructor(scope: Construct, name: string) {
    super(scope, name);
    new RandomProvider(this, "random", {});
    const randomId = new Id(this, "id", { byteLength: 4 });
    new TerraformOutput(this, "id_hex", { value: randomId.hex });
  }
}

const app = Testing.stubVersion(new App({ stackTraces: false }));
new OpenTofuTarget(app, "opentofu-target");
app.synth();
