// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

/**
 * Records which Terraform functions have been called through the `Fn` class
 * so that synthesis-time validations can check them against the version of
 * the selected Terraform-compatible CLI.
 *
 * The registry is intentionally process-global rather than stack-scoped:
 * an `Fn.*()` result is a plain token that can be shared freely across
 * stacks, so reliable per-stack attribution is impossible anyway. Functions
 * used through raw escape hatches (overrides, hand-built expression strings)
 * are not recorded.
 */
const usedFunctions = new Set<string>();

// eslint-disable-next-line jsdoc/require-jsdoc
export function recordFunctionUsage(functionName: string): void {
  usedFunctions.add(functionName);
}

// eslint-disable-next-line jsdoc/require-jsdoc
export function getUsedFunctions(): string[] {
  return Array.from(usedFunctions);
}

/**
 * Clears the recorded function usage; intended for tests.
 */
export function resetFunctionUsageRegistry(): void {
  usedFunctions.clear();
}

/**
 * Records which provider-defined functions (`provider::<name>::<function>`)
 * have been called through `TerraformProviderFunction.invoke` so that
 * synthesis-time validations can check them against the version of the
 * selected Terraform-compatible CLI.
 *
 * Kept separate from `usedFunctions` above: provider-defined functions are
 * validated against `providerFeatureConstraints.providerFunctions` (a single
 * language-support constraint for the whole feature family), not against the
 * per-function `functionVersionConstraints` map used for built-in `Fn.*`
 * functions.
 */
const usedProviderFunctions = new Set<string>();

// eslint-disable-next-line jsdoc/require-jsdoc
export function recordProviderFunctionUsage(fullName: string): void {
  usedProviderFunctions.add(fullName);
}

// eslint-disable-next-line jsdoc/require-jsdoc
export function getUsedProviderFunctions(): string[] {
  return Array.from(usedProviderFunctions);
}

/**
 * Clears the recorded provider function usage; intended for tests.
 */
export function resetProviderFunctionUsageRegistry(): void {
  usedProviderFunctions.clear();
}
