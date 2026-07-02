// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TerraformFeatureVersionConstraints } from "./validations/validate-terraform-feature-version";

/**
 * Minimum CLI version per product required for a provider-protocol feature
 * family, hand-maintained from `tools/provider-feature-availability/features-matrix.json`
 * (see that directory's README for how the dataset is produced/regenerated).
 *
 * Used by synth-time `ValidateFeatureTargetSupport` checks against a
 * project's declared `targetVersions`. Deliberately not exported from
 * src/index.ts: it is wired up from the specific constructs/generators that
 * need it rather than being part of cdktn's public API.
 */
export const providerFeatureConstraints = {
  providerFunctions: { terraform: ">=1.8.0", opentofu: ">=1.7.0" }, // opentofu language support since 1.7.0 even though schema emission starts 1.8.0
  ephemeralResources: { terraform: ">=1.10.0", opentofu: ">=1.11.0" },
  writeOnlyAttributes: { terraform: ">=1.11.0", opentofu: ">=1.11.0" },
  resourceIdentity: { terraform: ">=1.12.0", opentofu: ">=1.12.0" },
} as const satisfies Record<string, TerraformFeatureVersionConstraints>;
