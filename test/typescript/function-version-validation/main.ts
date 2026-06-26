// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from "constructs";
import { App, TerraformStack, TerraformOutput, Testing, Fn } from "cdktn";

export class FunctionVersionStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // universally available in every supported Terraform/OpenTofu release;
    // never validated against the declared targets
    new TerraformOutput(this, "universal", {
      value: Fn.abs(-42),
    });

    if (process.env.USE_CONSTRAINED_FUNCTION === "true") {
      // issensitive requires terraform >=1.8.0 / opentofu >=1.7.0, so it is
      // checked against the project's declared targetVersions
      new TerraformOutput(this, "constrained", {
        value: Fn.issensitive("not-actually-sensitive"),
      });
    }
  }
}

const app = Testing.stubVersion(new App({ stackTraces: false }));
new FunctionVersionStack(app, "function-version-validation");
app.synth();
