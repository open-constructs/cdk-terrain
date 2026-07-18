// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { IConstruct } from "constructs";

/**
 * Records which Terraform functions (`Fn.*` and provider-defined
 * `provider::<name>::<function>` calls) have actually been rendered into a
 * synthesized stack, so synthesis-time validations can check them against
 * the version of the selected Terraform-compatible CLI.
 *
 * Recording happens at token-RESOLVE time (`FunctionCall.resolve()` in
 * `tfExpression.ts`), not at call time: a `Fn.*()`/`invoke()` call merely
 * builds a token, and that token is only meaningful once it is resolved
 * while rendering a stack's `toTerraform()` output. Usage is keyed by
 * `context.scope.node.root` — the App that owns the stack doing the
 * resolving (or, in odd standalone test setups, whatever root construct is
 * doing the resolving). This makes usage owned by the App whose synthesis
 * renders the expression, not by the process:
 *
 * - Interleaved Apps (one App constructed, then a second App constructed
 *   before the first is synthesized) cannot cross-contaminate each other's
 *   usage, because each App is its own map key.
 * - A function call whose token never lands in any rendered output (e.g.
 *   built but discarded, or only ever passed to `JSON.stringify` outside of
 *   synthesis) is deliberately not recorded and therefore not validated.
 * - Functions used via raw escape hatches (overrides, hand-written
 *   expression strings) are never wrapped in a `FunctionCall` token and so
 *   are never recorded either.
 *
 * `App.synth()` runs a full preparing resolve of every stack's
 * `toTerraform()` for ALL of the App's stacks before any stack's
 * synthesizer runs validations, so usage recorded here during that pass is
 * always visible to the validations that read it afterwards.
 */
const usedFunctionsByRoot = new WeakMap<IConstruct, Set<string>>();
const usedProviderFunctionsByRoot = new WeakMap<IConstruct, Set<string>>();

// eslint-disable-next-line jsdoc/require-jsdoc
function recordIn(
  registry: WeakMap<IConstruct, Set<string>>,
  root: IConstruct,
  name: string,
): void {
  let usedNames = registry.get(root);
  if (!usedNames) {
    usedNames = new Set<string>();
    registry.set(root, usedNames);
  }
  usedNames.add(name);
}

// eslint-disable-next-line jsdoc/require-jsdoc
export function recordFunctionUsage(
  root: IConstruct,
  functionName: string,
): void {
  recordIn(usedFunctionsByRoot, root, functionName);
}

// eslint-disable-next-line jsdoc/require-jsdoc
export function getUsedFunctions(root: IConstruct): string[] {
  return Array.from(usedFunctionsByRoot.get(root) ?? []);
}

// eslint-disable-next-line jsdoc/require-jsdoc
export function recordProviderFunctionUsage(
  root: IConstruct,
  fullName: string,
): void {
  recordIn(usedProviderFunctionsByRoot, root, fullName);
}

// eslint-disable-next-line jsdoc/require-jsdoc
export function getUsedProviderFunctions(root: IConstruct): string[] {
  return Array.from(usedProviderFunctionsByRoot.get(root) ?? []);
}
