// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { IConstruct, IValidation } from "constructs";
import * as semver from "semver";
import { TerraformFeatureVersionConstraints } from "./validate-terraform-feature-version";

/**
 * Context key carrying the project's declared Terraform-compatible runtime
 * targets (set from the `targetVersions` field in cdktf.json by the CLI, or
 * directly via App context / CDKTF_CONTEXT_JSON for standalone synth).
 *
 * Kept in sync with TARGET_VERSIONS_CONTEXT_KEY in @cdktn/commons — the value
 * is duplicated because cdktn cannot depend on @cdktn/commons.
 */
export const TARGET_VERSIONS_CONTEXT_KEY = "targetVersions";

/**
 * The Terraform-compatible runtimes a project declares it supports, as npm
 * semver ranges per product. A missing product means the project does not
 * target that product.
 */
export interface TerraformTargetVersions {
  readonly terraform?: string;
  readonly opentofu?: string;
}

/**
 * Used when a project declares no `targetVersions`: the project is assumed
 * to target every supported release of both products, which is the strictest
 * (most portable) interpretation.
 */
export const DEFAULT_TARGET_VERSIONS: TerraformTargetVersions = {
  terraform: ">=1.5.7",
  opentofu: ">=1.6.0",
};

const TARGET_PRODUCTS = ["terraform", "opentofu"] as const;

/**
 * Resolves the declared target versions from construct context, falling back
 * to DEFAULT_TARGET_VERSIONS. Returns errors instead of targets when the
 * declared value is malformed (which can happen when context is set directly
 * on the App rather than going through cdktf.json validation).
 */
export function resolveTargetVersions(scope: IConstruct): {
  targets?: TerraformTargetVersions;
  errors: string[];
} {
  const declared = scope.node.tryGetContext(TARGET_VERSIONS_CONTEXT_KEY);
  if (declared === undefined) {
    return { targets: DEFAULT_TARGET_VERSIONS, errors: [] };
  }

  if (
    typeof declared !== "object" ||
    declared === null ||
    Array.isArray(declared)
  ) {
    return {
      errors: [
        `targetVersions context must be an object mapping products to semver ranges, e.g. { "terraform": ">=1.5.7" }`,
      ],
    };
  }

  const entries = Object.entries(declared);
  if (entries.length === 0) {
    return {
      errors: [
        `targetVersions must declare at least one product ("terraform" or "opentofu") or be omitted entirely`,
      ],
    };
  }

  const errors: string[] = [];
  for (const [product, range] of entries) {
    if (!TARGET_PRODUCTS.includes(product as any)) {
      errors.push(
        `targetVersions has unknown product "${product}" (expected "terraform" or "opentofu")`,
      );
    } else if (typeof range === "string" && range.includes("~>")) {
      // npm semver happens to parse "~>" as "~", which has different
      // semantics than Terraform's "~>" pessimistic constraint — reject it
      // instead of silently meaning something else
      errors.push(
        `targetVersions.${product} "${range}" uses Terraform provider constraint syntax; use npm semver ranges instead (e.g. ">=1.5.7" or "~1.5.7")`,
      );
    } else if (typeof range !== "string" || semver.validRange(range) === null) {
      errors.push(
        `targetVersions.${product} ${JSON.stringify(
          range,
        )} is not a valid semver range`,
      );
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  return { targets: declared as TerraformTargetVersions, errors: [] };
}

/**
 * Checks whether a feature is supported across the entire declared target
 * range of every targeted product.
 *
 * `supportedIn` follows the TerraformFeatureVersionConstraints semantics: a
 * missing product key means the feature is not supported by that product at
 * any version. The check is a semver range subset: declaring
 * `terraform: ">=1.5.7"` while a feature requires `>=1.8.0` fails, because
 * the project claims to support 1.5.7..1.8.0 where the feature is missing.
 */
export function checkFeatureSupportedByTargets(
  featureName: string,
  supportedIn: TerraformFeatureVersionConstraints,
  targets: TerraformTargetVersions,
  hint?: string,
): string[] {
  const errors: string[] = [];

  for (const product of TARGET_PRODUCTS) {
    const targetRange = targets[product];
    if (!targetRange) continue; // product not targeted by the project

    const supportedRange = supportedIn[product];
    if (!supportedRange) {
      errors.push(
        `${featureName} is not supported by ${product}, but the project targets ${product} ${targetRange}. ${
          hint || ""
        }`.trimEnd(),
      );
      continue;
    }

    if (!semver.subset(targetRange, supportedRange)) {
      errors.push(
        `${featureName} requires ${product} ${supportedRange}, but the project targets ${product} ${targetRange}. ${
          hint || ""
        }`.trimEnd(),
      );
    }
  }

  return errors;
}

/**
 * Validates that a feature is supported by the project's declared
 * Terraform-compatible runtime targets (cdktf.json `targetVersions`),
 * without probing any locally installed binary.
 *
 * Verifying the actually installed binary is a separate, explicit step:
 * the opt-in `validateInstalledBinary` config handled by the CLI commands
 * that execute the binary.
 */
export class ValidateFeatureTargetSupport implements IValidation {
  constructor(
    protected scope: IConstruct,
    protected featureName: string,
    protected supportedIn: TerraformFeatureVersionConstraints,
    protected hint?: string,
  ) {}

  public validate(): string[] {
    const { targets, errors } = resolveTargetVersions(this.scope);
    if (!targets) {
      return errors;
    }

    return checkFeatureSupportedByTargets(
      this.featureName,
      this.supportedIn,
      targets,
      this.hint,
    );
  }
}
