// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { Language } from "@cdktn/commons";
import { DependencyManager } from "../../lib/dependencies/dependency-manager";
import { providerAdd } from "../../lib/provider-add";

// init() scaffolds into a destination and calls providerAdd with that
// directory without changing cwd, so the registry has to come from the project
// being written to rather than from wherever the CLI runs.
//
// Spying on addLocalProvider rather than mocking the module keeps the real
// ProviderConstraint doing the normalizing, so the source it receives is what
// proves which registry providerAdd selected.
describe("providerAdd registry selection", () => {
  let tmpRoot: string;
  let previousCwd: string;
  let addLocalProvider: jest.SpyInstance;

  function project(name: string, targetVersions?: Record<string, string>) {
    const dir = path.join(tmpRoot, name);
    fs.mkdirpSync(dir);
    fs.writeFileSync(
      path.join(dir, "cdktf.json"),
      JSON.stringify({
        language: "typescript",
        app: "npx tsx main.ts",
        ...(targetVersions ? { targetVersions } : {}),
      }),
    );
    return dir;
  }

  async function sourceAddedTo(projectDirectory: string) {
    addLocalProvider.mockClear();
    await providerAdd({
      providers: ["hashicorp/random"],
      language: Language.TYPESCRIPT,
      projectDirectory,
      cdktfVersion: "0.0.0", // non-empty, so determineDeps is never called
      forceLocal: true,
    });
    expect(addLocalProvider).toHaveBeenCalledTimes(1);
    return addLocalProvider.mock.calls[0][0].source as string;
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "provider-add-registry"));
    previousCwd = process.cwd();
    addLocalProvider = jest
      .spyOn(DependencyManager.prototype, "addLocalProvider")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    addLocalProvider.mockRestore();
    process.chdir(previousCwd);
    fs.removeSync(tmpRoot);
  });

  it("follows the project directory, not the cwd", async () => {
    process.chdir(project("cwd-terraform"));
    const destination = project("destination-opentofu", {
      opentofu: ">=1.6.0",
    });

    expect(await sourceAddedTo(destination)).toBe(
      "registry.opentofu.org/hashicorp/random",
    );
  });

  it("does not let an OpenTofu cwd leak into a Terraform project", async () => {
    process.chdir(project("cwd-opentofu", { opentofu: ">=1.6.0" }));
    const destination = project("destination-terraform");

    expect(await sourceAddedTo(destination)).toBe(
      "registry.terraform.io/hashicorp/random",
    );
  });
});
