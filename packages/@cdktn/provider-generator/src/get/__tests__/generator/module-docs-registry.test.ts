// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import { CodeMaker } from "codemaker";
import {
  ConstructsMakerModuleTarget,
  Language,
  TerraformModuleConstraint,
  TerraformTargetVersions,
} from "@cdktn/commons";
import { ModuleGenerator } from "../../generator/module-generator";
import { createTmpHelper } from "../util";

const tmp = createTmpHelper();

async function docsComment(
  source: string,
  targetVersions?: TerraformTargetVersions,
): Promise<string> {
  const workdir = tmp("module-docs-registry");
  const target = ConstructsMakerModuleTarget.from(
    new TerraformModuleConstraint(source),
    Language.TYPESCRIPT,
  ) as ConstructsMakerModuleTarget;
  target.spec = { name: target.name, inputs: [], outputs: [] };

  const code = new CodeMaker();
  new ModuleGenerator(code, [target], targetVersions);
  await code.save(workdir);

  const emitted = fs.readFileSync(path.join(workdir, target.fileName), "utf-8");
  const line = emitted
    .split("\n")
    .find((l) => l.includes("Docs at") || l.includes("Source at"));
  return (line ?? "").trim();
}

describe("generated module docs links", () => {
  const module = "terraform-aws-modules/vpc/aws@3.19.0";
  const submodule =
    "terraform-aws-modules/vpc/aws//modules/vpc-endpoints@3.19.0";

  it("uses the Terraform Registry when nothing is declared", async () => {
    expect(await docsComment(module)).toContain(
      "https://registry.terraform.io/modules/terraform-aws-modules/vpc/aws/3.19.0",
    );
  });

  it("uses the Terraform Registry when both products are declared", async () => {
    expect(
      await docsComment(module, {
        terraform: ">=1.5.7",
        opentofu: ">=1.6.0",
      }),
    ).toContain("https://registry.terraform.io/modules/");
  });

  it("uses the OpenTofu Registry when only OpenTofu is declared", async () => {
    const comment = await docsComment(module, { opentofu: ">=1.6.0" });
    expect(comment).toContain("Docs at OpenTofu Registry");
    expect(comment).toContain(
      "https://search.opentofu.org/module/terraform-aws-modules/vpc/aws/v3.19.0",
    );
  });

  it("links an OpenTofu submodule with the singular segment", async () => {
    expect(await docsComment(submodule, { opentofu: ">=1.6.0" })).toContain(
      "https://search.opentofu.org/module/terraform-aws-modules/vpc/aws/v3.19.0/submodule/vpc-endpoints",
    );
  });

  it("keeps the Terraform submodule shape unchanged", async () => {
    expect(await docsComment(submodule)).toContain(
      "https://registry.terraform.io/modules/terraform-aws-modules/vpc/aws/3.19.0/submodules/vpc-endpoints",
    );
  });

  it("still points a local module at its source", async () => {
    expect(await docsComment("./module", { opentofu: ">=1.6.0" })).toContain(
      "Source at ./module",
    );
  });
});
