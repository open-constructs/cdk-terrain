// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as path from "path";
import {
  Language,
  TerraformProviderConstraint,
  TerraformTargetVersions,
} from "@cdktn/commons";
import { createTmpHelper } from "./util";

const mockReadSchema = jest.fn();
jest.mock("@cdktn/provider-schema", () => ({
  readSchema: (...args: unknown[]) => mockReadSchema(...args),
}));

// Imported after the mock so ConstructsMaker picks up the mocked readSchema.
import { ConstructsMaker } from "../constructs-maker";

const tmp = createTmpHelper();

// No resources, so generation stays in TypeScript emission.
const fakeSchema = {
  providerSchema: {
    format_version: "0.2" as const,
    provider_schemas: {
      "registry.terraform.io/hashicorp/random": {
        resource_schemas: null,
        data_source_schemas: null,
      },
    },
    provider_versions: { "registry.terraform.io/hashicorp/random": "3.2.0" },
    cli_name: "terraform",
    cli_version: "1.7.5",
  },
};

describe("filterAlreadyGenerated: registry class", () => {
  const constraint = new TerraformProviderConstraint("hashicorp/random@=3.2.0");
  let outdir: string;

  const maker = (targetVersions?: TerraformTargetVersions) =>
    new ConstructsMaker({
      codeMakerOutput: outdir,
      targetLanguage: Language.TYPESCRIPT,
      targetVersions,
    });

  /** A real previous `cdktn get`, so constraints.json is what generation writes. */
  const generateWith = (targetVersions?: TerraformTargetVersions) =>
    maker(targetVersions).generate([constraint]);

  beforeEach(() => {
    mockReadSchema.mockReset();
    mockReadSchema.mockResolvedValue(fakeSchema);
    outdir = tmp("registry-class");
  });

  it.each<
    [
      string,
      TerraformTargetVersions | undefined,
      TerraformTargetVersions | undefined,
    ]
  >([
    ["nothing changed", undefined, undefined],
    [
      "both products declared, the same class as nothing",
      undefined,
      { terraform: ">=1.5.7", opentofu: ">=1.6.0" },
    ],
    [
      "a range moving within the OpenTofu class",
      { opentofu: ">=1.6.0" },
      { opentofu: ">=1.8.0" },
    ],
  ])("skips regeneration: %s", async (_name, before, after) => {
    await generateWith(before);

    await expect(
      maker(after).filterAlreadyGenerated([constraint]),
    ).resolves.toEqual([]);
  });

  it("regenerates when the project switches to OpenTofu-only", async () => {
    await generateWith(undefined);

    await expect(
      maker({ opentofu: ">=1.6.0" }).filterAlreadyGenerated([constraint]),
    ).resolves.toEqual([constraint]);
  });

  it("regenerates when the project switches away from OpenTofu-only", async () => {
    await generateWith({ opentofu: ">=1.6.0" });

    await expect(
      maker({ terraform: ">=1.5.7" }).filterAlreadyGenerated([constraint]),
    ).resolves.toEqual([constraint]);
  });

  // constraints.json written before targetVersions was stamped has no such field;
  // it must read as the Terraform class, which is what it was generated for.
  describe("constraints.json from before targetVersions was recorded", () => {
    beforeEach(async () => {
      await generateWith({ terraform: ">=1.5.7" });
      const file = path.join(outdir, "constraints.json");
      const { targetVersions: _dropped, ...older } = fs.readJsonSync(file);
      fs.writeJsonSync(file, older);
    });

    it("is fresh for a Terraform project", async () => {
      await expect(
        maker().filterAlreadyGenerated([constraint]),
      ).resolves.toEqual([]);
    });

    it("is stale for an OpenTofu-only project", async () => {
      await expect(
        maker({ opentofu: ">=1.6.0" }).filterAlreadyGenerated([constraint]),
      ).resolves.toEqual([constraint]);
    });
  });
});
