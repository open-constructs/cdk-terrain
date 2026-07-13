// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TerraformFeatureVersionConstraints } from "./validations/validate-terraform-feature-version";

/**
 * Provider-protocol feature families whose usage is gated on the project's
 * declared `targetVersions`. Generated provider bindings pass a member of
 * this enum to `TerraformResource.registerProviderFeatureUsage()` when a
 * versioned feature is actually used; the per-product minimum versions live
 * in the (internal) `providerFeatureConstraints` map in this module.
 */
export enum ProviderFeature {
  /**
   * Provider-defined functions (`provider::<ns>::<fn>()` expressions).
   */
  PROVIDER_FUNCTIONS = "providerFunctions",
  /**
   * Ephemeral resources (`ephemeral` blocks), which are never persisted to
   * state or plan files.
   */
  EPHEMERAL_RESOURCES = "ephemeralResources",
  /**
   * Write-only resource attributes: accepted on create/update but never
   * persisted to state and never returned by the provider.
   */
  WRITE_ONLY_ATTRIBUTES = "writeOnlyAttributes",
  /**
   * Resource identity data alongside state. Reserved: not yet consumed by
   * any generated binding.
   */
  RESOURCE_IDENTITY = "resourceIdentity",
}

/**
 * Minimum CLI version per product required for a provider-protocol feature
 * family, hand-maintained from `tools/provider-feature-availability/features-matrix.json`
 * (see that directory's README for how the dataset is produced/regenerated,
 * and its "In-repo consumers" section for how this map relates to the
 * matrix and to the sibling `SCHEMA_EMISSION_BOUNDARIES` map in
 * `packages/@cdktn/provider-schema/src/emission-check.ts`).
 *
 * These are *usage* (language-support) boundaries, not schema-emission
 * boundaries — the two can differ per feature. In particular,
 * `providerFunctions.opentofu` is deliberately pinned to `>=1.7.0`, the
 * version where OpenTofu's HCL parser started accepting
 * `provider::ns::fn()`, even though `tofu providers schema -json` only
 * starts emitting the `functions` key from 1.8.0 (see
 * `SCHEMA_EMISSION_BOUNDARIES.functions.opentofu`). Do not "fix" this
 * mismatch without checking the matrix and the emission-check module first.
 *
 * There is no automated check that this map stays in sync with the matrix;
 * updates must be applied by hand when the matrix changes. An automated
 * drift check is tracked in #309.
 *
 * Used by synth-time `ValidateFeatureTargetSupport` checks against a
 * project's declared `targetVersions`. Deliberately not exported from
 * src/index.ts: it is wired up from the specific constructs/generators that
 * need it rather than being part of cdktn's public API. (The `ProviderFeature`
 * enum above IS exported - it appears in the public
 * `registerProviderFeatureUsage` signature, which jsii requires.)
 */
export const providerFeatureConstraints = {
  [ProviderFeature.PROVIDER_FUNCTIONS]: {
    terraform: ">=1.8.0",
    opentofu: ">=1.7.0",
  }, // opentofu language support since 1.7.0 even though schema emission starts 1.8.0
  [ProviderFeature.EPHEMERAL_RESOURCES]: {
    terraform: ">=1.10.0",
    opentofu: ">=1.11.0",
  },
  [ProviderFeature.WRITE_ONLY_ATTRIBUTES]: {
    terraform: ">=1.11.0",
    opentofu: ">=1.11.0",
  },
  [ProviderFeature.RESOURCE_IDENTITY]: {
    terraform: ">=1.12.0",
    opentofu: ">=1.12.0",
  },
} as const satisfies Record<
  ProviderFeature,
  TerraformFeatureVersionConstraints
>;

/**
 * Human-readable labels for each `providerFeatureConstraints` key, used as
 * the `featureName` passed to `ValidateFeatureTargetSupport` so synth-time
 * errors read naturally (e.g. "write-only attributes requires terraform
 * >=1.11.0, ...").
 */
export const providerFeatureLabels: Record<ProviderFeature, string> = {
  [ProviderFeature.PROVIDER_FUNCTIONS]: "provider functions",
  [ProviderFeature.EPHEMERAL_RESOURCES]: "ephemeral resources",
  [ProviderFeature.WRITE_ONLY_ATTRIBUTES]: "write-only attributes",
  [ProviderFeature.RESOURCE_IDENTITY]: "resource identity",
};
