// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

import { DEFAULT_TARGET_VERSIONS, TerraformCliVersion } from "@cdktn/commons";
import {
  checkSchemaEmissionGaps,
  suggestedEmittingCliVersions,
} from "../emission-check";

const cli = (name: TerraformCliVersion["name"], version: string) => ({
  name,
  version,
});

describe("checkSchemaEmissionGaps", () => {
  it("reports every gap when fetched with an old terraform and default targets", () => {
    const gaps = checkSchemaEmissionGaps(
      cli("terraform", "1.7.5"),
      DEFAULT_TARGET_VERSIONS,
    );

    expect(gaps).toEqual(
      expect.arrayContaining([
        "ephemeral resources",
        "provider functions",
        "write-only attributes",
        "resource identity",
      ]),
    );
    expect(gaps).toHaveLength(4);
  });

  it("reports no gaps when fetched with a recent terraform", () => {
    const gaps = checkSchemaEmissionGaps(
      cli("terraform", "1.15.6"),
      DEFAULT_TARGET_VERSIONS,
    );

    expect(gaps).toEqual([]);
  });

  it("reports gaps for an old opentofu fetch when opentofu is targeted", () => {
    const gaps = checkSchemaEmissionGaps(cli("opentofu", "1.10.0"), {
      opentofu: ">=1.11.0",
    });

    expect(gaps).toEqual(
      expect.arrayContaining([
        "ephemeral resources",
        "write-only attributes",
        "resource identity",
      ]),
    );
    // functions were already emitted as of opentofu 1.8.0, so the 1.10.0
    // fetch isn't missing them
    expect(gaps).not.toContain("provider functions");
  });

  it("does not warn about a feature the targets never admit", () => {
    // Pinned to a version that predates every emission boundary in this
    // family - the project itself never runs where the feature would show
    // up, so an old fetching CLI isn't a gap.
    const gaps = checkSchemaEmissionGaps(cli("terraform", "1.7.5"), {
      terraform: "1.6.6",
    });

    expect(gaps).toEqual([]);
  });

  it("returns no gaps for an unrecognized fetching CLI", () => {
    const gaps = checkSchemaEmissionGaps(
      { name: "unknown" },
      DEFAULT_TARGET_VERSIONS,
    );

    expect(gaps).toEqual([]);
  });

  it("does not throw and skips the product when targetVersions has a malformed range", () => {
    const gaps = checkSchemaEmissionGaps(cli("terraform", "1.7.5"), {
      terraform: "not-a-range",
    });

    expect(gaps).toEqual([]);
  });
});

describe("suggestedEmittingCliVersions", () => {
  it("suggests the highest boundary across the gapped families per product", () => {
    expect(
      suggestedEmittingCliVersions(["functions", "ephemeral_resource_schemas"]),
    ).toBe("terraform >=1.10.0 / opentofu >=1.11.0");
  });

  it("suggests the identity boundary when identity is the only gap", () => {
    expect(suggestedEmittingCliVersions(["resource_identity_schemas"])).toBe(
      "terraform >=1.12.0 / opentofu >=1.12.0",
    );
  });
});
