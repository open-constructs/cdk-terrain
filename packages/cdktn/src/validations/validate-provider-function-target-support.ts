// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { IConstruct, IValidation } from "constructs";
import {
  checkFeatureSupportedByTargets,
  resolveTargetVersions,
} from "./target-versions";
import { providerFeatureConstraints } from "../provider-feature-constraints";
import { getUsedProviderFunctions } from "../functions/usage-registry";

/**
 * Validates that any provider-defined functions
 * (`provider::<name>::<function>()`) invoked through
 * `TerraformProviderFunction.invoke` are supported by the project's declared
 * Terraform/OpenTofu targets (cdktf.json `targetVersions`, defaulting to the
 * dual product baseline).
 *
 * Unlike `ValidateFunctionVersionSupport`, there is a single version
 * constraint for the whole feature family (provider-defined function call
 * syntax), not one per function — so this check is skipped entirely when no
 * provider function has been used, and otherwise checked once, naming every
 * used function so the error is actionable.
 *
 * Registered unconditionally (no feature flag): this is new API surface, and
 * the check only ever fires when a provider function is actually used
 * during the current synthesis session (i.e. since the enclosing `App` was
 * constructed — see the usage-registry reset in `App`'s constructor).
 */
export class ValidateProviderFunctionTargetSupport implements IValidation {
  constructor(protected scope: IConstruct) {}

  public validate() {
    const usedProviderFunctions = getUsedProviderFunctions().sort();

    // no provider-defined functions in use: nothing to validate
    if (usedProviderFunctions.length === 0) {
      return [];
    }

    const { targets, errors } = resolveTargetVersions(this.scope);
    if (!targets) {
      return errors;
    }

    return checkFeatureSupportedByTargets(
      `provider-defined functions (${usedProviderFunctions.join(", ")})`,
      providerFeatureConstraints.providerFunctions,
      targets,
      availabilityHint(),
    );
  }
}

/**
 * Tells the user where provider-defined functions ARE available, so they
 * can adjust their declared targetVersions.
 */
function availabilityHint(): string {
  const parts = Object.entries(
    providerFeatureConstraints.providerFunctions,
  ).map(([product, range]) => `${product} ${range}`);
  return `Provider-defined functions are available in ${parts.join(" and ")}.`;
}
