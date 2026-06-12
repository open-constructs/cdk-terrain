// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { checkInstalledBinaryAgainstTargets } from "../../lib/installed-binary-check";

describe("checkInstalledBinaryAgainstTargets", () => {
  const terraformOutput = "Terraform v1.6.5\non linux_amd64";
  const openTofuOutput = "OpenTofu v1.9.3\non linux_amd64";

  it("passes when the installed binary satisfies the declared range", () => {
    expect(
      checkInstalledBinaryAgainstTargets(
        terraformOutput,
        { terraform: ">=1.5.7" },
        "terraform",
      ),
    ).toEqual([]);
  });

  it("evaluates the range of the detected product", () => {
    expect(
      checkInstalledBinaryAgainstTargets(
        openTofuOutput,
        { terraform: ">=1.10.0", opentofu: ">=1.6.0" },
        "tofu",
      ),
    ).toEqual([]);
  });

  it("fails when the installed binary is outside the declared range", () => {
    expect(
      checkInstalledBinaryAgainstTargets(
        terraformOutput,
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
        openTofuOutput,
        { terraform: ">=1.5.7" },
        "tofu",
      ),
    ).toEqual([
      `The installed binary "tofu" is opentofu 1.9.3, but the project's targetVersions does not declare opentofu (declared: {"terraform":">=1.5.7"})`,
    ]);
  });

  it("falls back to the dual product baseline when nothing is declared", () => {
    expect(
      checkInstalledBinaryAgainstTargets(
        terraformOutput,
        undefined,
        "terraform",
      ),
    ).toEqual([]);
    expect(
      checkInstalledBinaryAgainstTargets(openTofuOutput, undefined, "tofu"),
    ).toEqual([]);
  });

  it("reports unparseable version output", () => {
    expect(
      checkInstalledBinaryAgainstTargets(
        '{"terraform_version":"1.6.5"}',
        { terraform: ">=1.5.7" },
        "terraform",
      ),
    ).toEqual([
      `Could not determine whether terraform is Terraform or OpenTofu from its version output, unable to verify it against the declared targetVersions`,
    ]);
  });
});
