// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as semver from "semver";

import type {
  TerraformCliVersion,
  TerraformTargetVersions,
} from "@cdktn/commons";

/**
 * The newer-protocol schema sections that a fetching CLI only starts to
 * *emit* in `terraform providers schema -json` as of a certain version.
 *
 * NOTE: these are emission boundaries, not language-support boundaries -
 * e.g. provider functions are usable in HCL since Terraform 1.7.0, but only
 * show up in the schema dump as of 1.8.0.
 */
export type SchemaEmissionFamily =
  | "functions"
  | "ephemeral_resource_schemas"
  | "write_only"
  | "resource_identity_schemas";

const TARGET_PRODUCTS = ["terraform", "opentofu"] as const;
type TargetProduct = (typeof TARGET_PRODUCTS)[number];

export const SCHEMA_EMISSION_BOUNDARIES: Record<
  SchemaEmissionFamily,
  Record<TargetProduct, string>
> = {
  functions: { terraform: "1.8.0", opentofu: "1.8.0" },
  ephemeral_resource_schemas: { terraform: "1.10.0", opentofu: "1.11.0" },
  write_only: { terraform: "1.11.0", opentofu: "1.11.0" },
  resource_identity_schemas: { terraform: "1.12.0", opentofu: "1.12.0" },
};

export const SCHEMA_EMISSION_FAMILY_LABELS: Record<
  SchemaEmissionFamily,
  string
> = {
  functions: "provider functions",
  ephemeral_resource_schemas: "ephemeral resources",
  write_only: "write-only attributes",
  resource_identity_schemas: "resource identity",
};

/**
 * Determines which schema-emission gaps the given fetching CLI has, in
 * light of the project's declared `targetVersions`.
 *
 * A family is reported when both are true:
 * - the fetching CLI's own version predates that family's emission
 *   boundary for its product (so this particular fetch could not have
 *   included the section, even if the provider implements it)
 * - at least one of the project's targeted products declares a range that
 *   intersects the versions where that family is emitted (i.e. the project
 *   actually intends to run on versions where the feature would show up)
 *
 * @internal exposed for testing
 */
export function checkSchemaEmissionGaps(
  cli: TerraformCliVersion,
  targets: TerraformTargetVersions,
): string[] {
  return checkSchemaEmissionGapFamilies(cli, targets).map(
    (family) => SCHEMA_EMISSION_FAMILY_LABELS[family],
  );
}

/**
 * Same as checkSchemaEmissionGaps, but returns the raw family keys so
 * callers can also compute a remedy (see suggestedEmittingCliVersions).
 *
 * @internal exposed for testing
 */
export function checkSchemaEmissionGapFamilies(
  cli: TerraformCliVersion,
  targets: TerraformTargetVersions,
): SchemaEmissionFamily[] {
  if (cli.name === "unknown" || !cli.version) return [];
  const cliProduct = cli.name as TargetProduct;

  const gaps: SchemaEmissionFamily[] = [];

  for (const family of Object.keys(
    SCHEMA_EMISSION_BOUNDARIES,
  ) as SchemaEmissionFamily[]) {
    const boundaries = SCHEMA_EMISSION_BOUNDARIES[family];
    const cliBoundary = boundaries[cliProduct];
    if (!cliBoundary) continue;

    // The fetching CLI is new enough to emit this family - no gap.
    if (!semver.lt(cli.version, cliBoundary)) continue;

    const wanted = TARGET_PRODUCTS.some((product) => {
      const targetRange = targets[product];
      if (!targetRange) return false;
      const supportedRange = `>=${boundaries[product]}`;
      return semver.intersects(targetRange, supportedRange);
    });

    if (wanted) gaps.push(family);
  }

  return gaps;
}

/**
 * The lowest CLI version per product whose `providers schema -json` emits
 * every one of the given families — the remedy to suggest alongside the
 * fetch-time warning.
 *
 * @internal exposed for testing
 */
export function suggestedEmittingCliVersions(
  families: SchemaEmissionFamily[],
): string {
  return TARGET_PRODUCTS.map((product) => {
    const needed = families
      .map((family) => SCHEMA_EMISSION_BOUNDARIES[family][product])
      .sort(semver.compare)
      .pop();
    return needed ? `${product} >=${needed}` : undefined;
  })
    .filter((part) => part !== undefined)
    .join(" / ");
}
