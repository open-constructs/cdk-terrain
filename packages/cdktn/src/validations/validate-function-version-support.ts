// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { IConstruct, IValidation } from "constructs";
import {
  checkFeatureSupportedByTargets,
  resolveTargetVersions,
} from "./target-versions";
import {
  FunctionVersionConstraints,
  functionVersionConstraints,
} from "../functions/function-availability.generated";
import { TerraformStack } from "../terraform-stack";

/**
 * Validates that every Terraform function used through `Fn` is supported by
 * the project's declared Terraform/OpenTofu targets (cdktf.json
 * `targetVersions`, defaulting to the dual product baseline).
 *
 * Most functions are universally available and are not checked at all; only
 * functions listed in the generated availability map are validated. The
 * check is purely declarative — no binary is executed — so synth behaves
 * identically in CI, package builds, and environments without Terraform or
 * OpenTofu installed. Verifying the actually installed binary is the
 * separate, opt-in `validateInstalledBinary` CLI behavior.
 *
 * Functions used via raw escape hatches (overrides, hand-written expression
 * strings) are not tracked and therefore not validated.
 *
 * Usage is read from the OWNING STACK (`TerraformStack._getUsedFunctions()`)
 * rather than from `node.root`: this validation is registered in
 * `TerraformStack`'s constructor with the stack itself as scope, and
 * `resolveTargetVersions` below walks context up from that same scope, so a
 * per-stack `targetVersions` override is possible - reading a root-keyed
 * (App-wide) usage record would validate one stack's usage against a
 * sibling stack's targets. See `TerraformStack._usedFunctions` for the full
 * rationale.
 */
export class ValidateFunctionVersionSupport implements IValidation {
  constructor(protected scope: IConstruct) {}

  public validate() {
    const stack = TerraformStack.isStack(this.scope)
      ? this.scope
      : TerraformStack.of(this.scope);
    const constrainedFunctions = stack
      ._getUsedFunctions()
      .filter((name) => name in functionVersionConstraints)
      .sort();

    // only universally available functions in use: nothing to validate
    if (constrainedFunctions.length === 0) {
      return [];
    }

    const { targets, errors } = resolveTargetVersions(this.scope);
    if (!targets) {
      return errors;
    }

    return constrainedFunctions.flatMap((name) => {
      const supportedIn = functionVersionConstraints[name];
      return checkFeatureSupportedByTargets(
        `Terraform function "${name}"`,
        supportedIn,
        targets,
        availabilityHint(supportedIn),
      );
    });
  }
}

/**
 * Tells the user where the function IS available, so they can adjust their
 * declared targetVersions (or drop the function).
 */
function availabilityHint(supportedIn: FunctionVersionConstraints): string {
  const parts = Object.entries(supportedIn).map(
    ([product, range]) => `${product} ${range}`,
  );
  return `It is available in ${parts.join(" and ")}.`;
}
