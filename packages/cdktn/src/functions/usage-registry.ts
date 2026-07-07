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
 *
 * Because the registry is process-global, `App`'s constructor resets it: a
 * new `App` marks a new synthesis session, so usage recorded while
 * synthesizing one App must not leak into validations for a later,
 * unrelated App constructed in the same Node process (e.g. sequential apps
 * in one test file). Within a single App, sharing this registry across all
 * of its stacks is by design (see the validation classes that consume it).
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
 *
 * Just like `usedFunctions`, this is process-global and is reset in `App`'s
 * constructor for the same reason: a new App starts a new synthesis
 * session, and usage must not leak across unrelated Apps in the same
 * process.
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
