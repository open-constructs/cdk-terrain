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
  const submodule =
    "terraform-aws-modules/vpc/aws//modules/vpc-endpoints@3.19.0";

  it("links an OpenTofu submodule with the singular segment", async () => {
    expect(await docsComment(submodule, { opentofu: ">=1.6.0" })).toContain(
      "https://search.opentofu.org/module/terraform-aws-modules/vpc/aws/v3.19.0/submodule/vpc-endpoints",
    );
  });

  // Registries serve submodule pages only for a direct child of `modules/`
  // (checked against rendered pages); anything else links to the module.
  it.each([
    [
      "an examples path",
      "terraform-aws-modules/vpc/aws//examples/complete@3.19.0",
    ],
    [
      "a nested modules path",
      "terraform-aws-modules/vpc/aws//modules/x/y@3.19.0",
    ],
  ])("links %s to the module page", async (_name, source) => {
    expect(await docsComment(source)).toContain(
      "{@link https://registry.terraform.io/modules/terraform-aws-modules/vpc/aws/3.19.0 ",
    );
    expect(await docsComment(source, { opentofu: ">=1.6.0" })).toContain(
      "{@link https://search.opentofu.org/module/terraform-aws-modules/vpc/aws/v3.19.0 ",
    );
  });

  // A range names no page, and its space would split the {@link} target from its text.
  it("links a ranged version to the latest page with the link intact", async () => {
    const comment = await docsComment("terraform-aws-modules/vpc/aws@~> 19.0", {
      opentofu: ">=1.6.0",
    });
    expect(comment).toContain(
      "{@link https://search.opentofu.org/module/terraform-aws-modules/vpc/aws/latest terraform-aws-modules/vpc/aws}",
    );
  });

  it("keeps the Terraform submodule shape unchanged", async () => {
    expect(await docsComment(submodule)).toContain(
      "https://registry.terraform.io/modules/terraform-aws-modules/vpc/aws/3.19.0/submodules/vpc-endpoints",
    );
  });
});
