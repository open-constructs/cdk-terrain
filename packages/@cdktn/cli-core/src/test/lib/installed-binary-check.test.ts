// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TerraformCliProbe, identifyTerraformCli } from "@cdktn/commons";
import { CdktfProject } from "../../lib/cdktf-project";
import { CdktfStack } from "../../lib/cdktf-stack";
import { checkInstalledBinaryAgainstTargets } from "../../lib/installed-binary-check";
import { SynthesizedStack } from "../../lib/synth-stack";

jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  identifyTerraformCli: jest.fn(),
}));

describe("checkInstalledBinaryAgainstTargets", () => {
  const terraform: TerraformCliProbe = { name: "terraform", version: "1.6.5" };
  const openTofu: TerraformCliProbe = { name: "opentofu", version: "1.9.3" };

  it("passes when the installed binary satisfies the declared range", () => {
    expect(
      checkInstalledBinaryAgainstTargets(
        terraform,
        { terraform: ">=1.5.7" },
        "terraform",
      ),
    ).toEqual([]);
  });

  it("evaluates the range of the detected product", () => {
    expect(
      checkInstalledBinaryAgainstTargets(
        openTofu,
        { terraform: ">=1.10.0", opentofu: ">=1.6.0" },
        "tofu",
      ),
    ).toEqual([]);
  });

  it("fails when the installed binary is outside the declared range", () => {
    expect(
      checkInstalledBinaryAgainstTargets(
        terraform,
        { terraform: ">=1.10.0" },
        "terraform",
      ),
    ).toEqual([
      `The installed binary "terraform" is terraform 1.6.5, which is outside the project's declared targetVersions.terraform range ">=1.10.0"`,
    ]);
  });

  it("fails when the project does not declare the installed product", () => {
    expect(
      checkInstalledBinaryAgainstTargets(
        openTofu,
        { terraform: ">=1.5.7" },
        "tofu",
      ),
    ).toEqual([
      `The installed binary "tofu" is opentofu 1.9.3, but the project's targetVersions does not declare opentofu (declared: {"terraform":">=1.5.7"})`,
    ]);
  });

  it("falls back to the dual product baseline when nothing is declared", () => {
    expect(
      checkInstalledBinaryAgainstTargets(terraform, undefined, "terraform"),
    ).toEqual([]);
    expect(
      checkInstalledBinaryAgainstTargets(openTofu, undefined, "tofu"),
    ).toEqual([]);
  });

  // The check is opt-in and strict: a binary it cannot verify must not pass.
  it.each([
    [
      "cannot be found",
      { name: "missing" } as const,
      `The binary "terraform" could not be found, so it could not be verified against the declared targetVersions`,
    ],
    [
      "cannot be identified",
      { name: "unknown" } as const,
      `Could not determine whether terraform is Terraform or OpenTofu from its version output, so it could not be verified against the declared targetVersions`,
    ],
  ])("fails when the binary %s", (_name, cli, message) => {
    expect(
      checkInstalledBinaryAgainstTargets(
        cli,
        { terraform: ">=1.5.7" },
        "terraform",
      ),
    ).toEqual([message]);
  });
});

function synthesized(name: string): SynthesizedStack {
  return {
    name,
    dependencies: [],
    annotations: [],
    content: JSON.stringify({ "//": { metadata: {}, outputs: {} } }),
    constructPath: ".",
    synthesizedStackPath: ".",
    workingDirectory: ".",
    stackMetadataPath: ".",
  };
}

// The check runs once per command, before any stack initializes, so a
// mismatch never stops a multi-stack run partway.
describe("CdktfProject with validateInstalledBinary", () => {
  const identify = identifyTerraformCli as jest.Mock;
  const originalCwd = process.cwd();
  let projectDir: string;
  let initialize: jest.SpyInstance;

  function project() {
    const p = new CdktfProject({
      synthCommand: "unused",
      outDir: "unused",
      onUpdate: () => {},
    });
    jest
      .spyOn(p as any, "readSynthesizedStacks")
      .mockResolvedValue([synthesized("a"), synthesized("b")]);
    return p;
  }

  const run = (p: CdktfProject, method: string) =>
    method === "diff"
      ? p.diff({ skipSynth: true, stackName: "a" })
      : method === "fetchOutputs"
        ? p.fetchOutputs({ skipSynth: true, stackNames: ["a", "b"] })
        : (p as any)[method]({
            skipSynth: true,
            autoApprove: true,
            stackNames: ["a", "b"],
          });

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "binary-check-"));
    fs.writeFileSync(
      path.join(projectDir, "cdktf.json"),
      JSON.stringify({
        language: "typescript",
        app: "npx tsx main.ts",
        validateInstalledBinary: true,
        targetVersions: { terraform: ">=1.10.0" },
      }),
    );
    process.chdir(projectDir);
    initialize = jest
      .spyOn(CdktfStack.prototype, "initalizeTerraform")
      .mockResolvedValue(undefined as any);
    jest
      .spyOn(CdktfStack.prototype as any, "terraformClient")
      .mockResolvedValue({
        deploy: async () => ({ cancelled: false }),
        destroy: async () => ({ cancelled: false }),
        output: async () => ({}),
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    identify.mockReset();
    process.chdir(originalCwd);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it.each(["diff", "deploy", "destroy", "fetchOutputs"])(
    "%s fails before any stack initializes",
    async (method) => {
      identify.mockResolvedValue({ name: "terraform", version: "1.6.5" });

      await expect(run(project(), method)).rejects.toThrow(
        `The installed binary "terraform" is terraform 1.6.5, which is outside the project's declared targetVersions.terraform range ">=1.10.0"`,
      );
      expect(initialize).not.toHaveBeenCalled();
    },
  );

  it("runs `version` once for a command over several stacks", async () => {
    identify.mockResolvedValue({ name: "terraform", version: "1.10.2" });

    await run(project(), "deploy");

    expect(identify).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(2);
  });
});
