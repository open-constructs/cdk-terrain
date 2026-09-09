// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { App, TerraformStack, TerraformOutput } from "cdktn";
import { Construct } from "constructs";
import { TimeProvider } from "./.gen/providers/time/provider";

// Provider-defined functions are only emitted into a provider schema by
// Terraform >= 1.8 and OpenTofu >= 1.8, so this stack can only be synthesized
// by the runtimes this test is pinned to. See pinnedRuntimes in
// tools/build-test-matrix.mjs.
class ProviderFunctionsStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const provider = new TimeProvider(this, "time");

    const parsed = provider.functions.rfc3339Parse("2024-01-02T03:04:05Z");

    new TerraformOutput(this, "parsed", {
      value: parsed,
    });
  }
}

const app = new App();
new ProviderFunctionsStack(app, "provider-functions");
app.synth();
