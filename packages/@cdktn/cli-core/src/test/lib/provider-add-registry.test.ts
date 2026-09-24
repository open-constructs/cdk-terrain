// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  OPENTOFU_REGISTRY,
  TERRAFORM_REGISTRY,
  readConfigSync,
  registryForTargetVersions,
} from "@cdktn/commons";

// init() scaffolds into a destination and calls providerAdd with that
// directory without changing cwd, so the registry must come from the project
// being written to, not from wherever the CLI happens to be running.
describe("registry selection for a project directory", () => {
  let tmpRoot: string;
  let cwdProject: string;
  let targetProject: string;
  let previousCwd: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "provider-add-registry"));
    cwdProject = path.join(tmpRoot, "cwd-project");
    targetProject = path.join(tmpRoot, "target-project");
    fs.mkdirpSync(cwdProject);
    fs.mkdirpSync(targetProject);

    // The directory the CLI runs from targets Terraform...
    fs.writeFileSync(
      path.join(cwdProject, "cdktf.json"),
      JSON.stringify({ language: "typescript", app: "npx tsx main.ts" }),
    );
    // ...while the project being written to targets OpenTofu only.
    fs.writeFileSync(
      path.join(targetProject, "cdktf.json"),
      JSON.stringify({
        language: "typescript",
        app: "npx tsx main.ts",
        targetVersions: { opentofu: ">=1.6.0" },
      }),
    );

    previousCwd = process.cwd();
    process.chdir(cwdProject);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.removeSync(tmpRoot);
  });

  it("uses the target project's registry, not the cwd's", () => {
    const fromTarget = registryForTargetVersions(
      readConfigSync(path.join(targetProject, "cdktf.json")).targetVersions,
    );
    expect(fromTarget).toBe(OPENTOFU_REGISTRY);
  });

  it("would pick the wrong registry if it read the cwd", () => {
    const fromCwd = registryForTargetVersions(readConfigSync().targetVersions);
    expect(fromCwd).toBe(TERRAFORM_REGISTRY);
  });
});
