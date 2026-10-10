// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  DISPLAY_VERSION,
  Language,
  TerraformProviderConstraint,
  TerraformTargetVersions,
} from "@cdktn/commons";
import { ConstructsMaker } from "../constructs-maker";

describe("filterAlreadyGenerated: registry class", () => {
  const constraint = new TerraformProviderConstraint("hashicorp/random@=3.2.0");
  let outdir: string;

  /** Simulates a previous `cdktn get` that generated this provider. */
  const writePreviousRun = (targetVersions?: TerraformTargetVersions) => {
    fs.mkdirpSync(path.join(outdir, "providers", "random"));
    fs.writeFileSync(
      path.join(outdir, "constraints.json"),
      JSON.stringify({
        cdktf: DISPLAY_VERSION,
        providers: { "hashicorp/random": "=3.2.0" },
        ...(targetVersions ? { targetVersions } : {}),
      }),
    );
  };

  const maker = (targetVersions?: TerraformTargetVersions) =>
    new ConstructsMaker({
      codeMakerOutput: outdir,
      targetLanguage: Language.TYPESCRIPT,
      targetVersions,
    });

  beforeEach(() => {
    outdir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-class-"));
  });

  it("skips a provider when nothing changed", async () => {
    writePreviousRun();

    await expect(maker().filterAlreadyGenerated([constraint])).resolves.toEqual(
      [],
    );
  });

  it("regenerates when the project switches to OpenTofu-only", async () => {
    writePreviousRun();

    await expect(
      maker({ opentofu: ">=1.6.0" }).filterAlreadyGenerated([constraint]),
    ).resolves.toEqual([constraint]);
  });

  it("regenerates when the project switches away from OpenTofu-only", async () => {
    writePreviousRun({ opentofu: ">=1.6.0" });

    await expect(
      maker({ terraform: ">=1.5.7" }).filterAlreadyGenerated([constraint]),
    ).resolves.toEqual([constraint]);
  });

  it("skips when only the version range moves within the same class", async () => {
    writePreviousRun({ opentofu: ">=1.6.0" });

    await expect(
      maker({ opentofu: ">=1.8.0" }).filterAlreadyGenerated([constraint]),
    ).resolves.toEqual([]);
  });

  it("skips when declaring both products, which is the same class as declaring nothing", async () => {
    writePreviousRun();

    await expect(
      maker({
        terraform: ">=1.5.7",
        opentofu: ">=1.6.0",
      }).filterAlreadyGenerated([constraint]),
    ).resolves.toEqual([]);
  });
});
