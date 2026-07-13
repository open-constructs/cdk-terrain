// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from "constructs";
import { Token } from "./tokens";
import { TerraformElement } from "./terraform-element";
import { TerraformProvider } from "./terraform-provider";
import {
  TerraformProviderGeneratorMetadata,
  lifecycleToTerraform,
} from "./terraform-resource";
import { Precondition, Postcondition } from "./terraform-conditions";
import {
  keysToSnakeCase,
  deepMerge,
  processDynamicAttributes,
  processDynamicAttributesForHcl,
} from "./util";
import { ITerraformDependable } from "./terraform-dependable";
import { ref, dependable } from "./tfExpression";
import { IResolvable } from "./tokens/resolvable";
import { IInterpolatingParent } from "./terraform-addressable";
import { ITerraformIterator } from "./terraform-iterator";
import { TerraformCount } from "./terraform-count";
import { ValidateFeatureTargetSupport } from "./validations/target-versions";
import {
  ProviderFeature,
  providerFeatureConstraints,
  providerFeatureLabels,
} from "./provider-feature-constraints";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import assert = require("assert");

const TERRAFORM_EPHEMERAL_RESOURCE_SYMBOL = Symbol.for(
  "cdktf/TerraformEphemeralResource",
);

/**
 * Tells the user where ephemeral resources ARE available, so they can adjust
 * their declared targetVersions.
 */
const EPHEMERAL_RESOURCES_HINT = `Ephemeral resources are available in ${Object.entries(
  providerFeatureConstraints[ProviderFeature.EPHEMERAL_RESOURCES],
)
  .map(([product, range]) => `${product} ${range}`)
  .join(" and ")}.`;

/**
 * Lifecycle options supported by Terraform ephemeral blocks. Unlike managed
 * resources, ephemeral resources have no state, so Terraform only supports
 * `precondition`/`postcondition` here - `createBeforeDestroy`,
 * `preventDestroy`, `ignoreChanges`, and `replaceTriggeredBy` are all
 * state-oriented concepts that do not apply.
 */
export interface TerraformEphemeralResourceLifecycle {
  readonly precondition?: Precondition[];
  readonly postcondition?: Postcondition[];
}

export interface ITerraformEphemeralResource {
  readonly terraformResourceType: string;
  readonly fqn: string;
  readonly friendlyUniqueId: string;

  dependsOn?: string[];
  count?: number | TerraformCount;
  provider?: TerraformProvider;
  lifecycle?: TerraformEphemeralResourceLifecycle;
  forEach?: ITerraformIterator;

  interpolationForAttribute(terraformAttribute: string): IResolvable;
}

/**
 * Meta-arguments accepted by ephemeral resources. Terraform ephemeral blocks
 * do not support provisioners or connection blocks, unlike managed resources.
 */
export interface TerraformEphemeralMetaArguments {
  readonly dependsOn?: ITerraformDependable[];
  readonly count?: number | TerraformCount;
  readonly provider?: TerraformProvider;
  readonly lifecycle?: TerraformEphemeralResourceLifecycle;
  readonly forEach?: ITerraformIterator;
}

export interface TerraformEphemeralResourceConfig extends TerraformEphemeralMetaArguments {
  readonly terraformResourceType: string;
  readonly terraformGeneratorMetadata?: TerraformProviderGeneratorMetadata;
}

// eslint-disable-next-line jsdoc/require-jsdoc
export class TerraformEphemeralResource
  extends TerraformElement
  implements
    ITerraformEphemeralResource,
    ITerraformDependable,
    IInterpolatingParent
{
  public readonly terraformResourceType: string;
  public readonly terraformGeneratorMetadata?: TerraformProviderGeneratorMetadata;

  // TerraformEphemeralMetaArguments

  public dependsOn?: string[];
  public count?: number | TerraformCount;
  public provider?: TerraformProvider;
  public lifecycle?: TerraformEphemeralResourceLifecycle;
  public forEach?: ITerraformIterator;

  constructor(
    scope: Construct,
    id: string,
    config: TerraformEphemeralResourceConfig,
  ) {
    super(scope, id, `ephemeral.${config.terraformResourceType}`);
    Object.defineProperty(this, TERRAFORM_EPHEMERAL_RESOURCE_SYMBOL, {
      value: true,
    });

    this.terraformResourceType = config.terraformResourceType;
    this.terraformGeneratorMetadata = config.terraformGeneratorMetadata;
    if (Array.isArray(config.dependsOn)) {
      this.dependsOn = config.dependsOn.map((dependency) =>
        dependable(dependency),
      );
    }
    this.count = config.count;
    this.provider = config.provider;
    this.lifecycle = config.lifecycle;
    this.forEach = config.forEach;

    this.node.addValidation(
      new ValidateFeatureTargetSupport(
        this,
        providerFeatureLabels[ProviderFeature.EPHEMERAL_RESOURCES],
        providerFeatureConstraints[ProviderFeature.EPHEMERAL_RESOURCES],
        EPHEMERAL_RESOURCES_HINT,
      ),
    );
  }

  public static isTerraformEphemeralResource(
    x: any,
  ): x is TerraformEphemeralResource {
    return (
      x !== null &&
      typeof x === "object" &&
      TERRAFORM_EPHEMERAL_RESOURCE_SYMBOL in x
    );
  }

  public getStringAttribute(terraformAttribute: string) {
    return Token.asString(this.interpolationForAttribute(terraformAttribute));
  }

  public getNumberAttribute(terraformAttribute: string) {
    return Token.asNumber(this.interpolationForAttribute(terraformAttribute));
  }

  public getListAttribute(terraformAttribute: string) {
    return Token.asList(this.interpolationForAttribute(terraformAttribute));
  }

  public getBooleanAttribute(terraformAttribute: string) {
    return this.interpolationForAttribute(terraformAttribute);
  }

  public getNumberListAttribute(terraformAttribute: string) {
    return Token.asNumberList(
      this.interpolationForAttribute(terraformAttribute),
    );
  }

  public getStringMapAttribute(terraformAttribute: string) {
    return Token.asStringMap(
      this.interpolationForAttribute(terraformAttribute),
    );
  }

  public getNumberMapAttribute(terraformAttribute: string) {
    return Token.asNumberMap(
      this.interpolationForAttribute(terraformAttribute),
    );
  }

  public getBooleanMapAttribute(terraformAttribute: string) {
    return Token.asBooleanMap(
      this.interpolationForAttribute(terraformAttribute),
    );
  }

  public getAnyMapAttribute(terraformAttribute: string) {
    return Token.asAnyMap(this.interpolationForAttribute(terraformAttribute));
  }

  public get terraformMetaArguments(): { [name: string]: any } {
    assert(
      !this.forEach || typeof this.count === "undefined",
      `forEach and count are both set, but they are mutually exclusive. You can only use either of them. Check the ephemeral resource at path: ${this.node.path}`,
    );

    return {
      dependsOn: this.dependsOn,
      count: TerraformCount.isTerraformCount(this.count)
        ? this.count.toTerraform()
        : this.count,
      provider: this.provider?.fqn,
      lifecycle: lifecycleToTerraform(this.lifecycle),
      forEach: this.forEach?._getForEachExpression(),
    };
  }

  // jsii can't handle abstract classes?
  protected synthesizeAttributes(): { [name: string]: any } {
    return {};
  }
  protected synthesizeHclAttributes(): { [name: string]: any } {
    return {};
  }

  /**
   * Adds this ephemeral resource to the terraform JSON output.
   */
  public toTerraform(): any {
    const attributes = deepMerge(
      processDynamicAttributes(this.synthesizeAttributes()),
      keysToSnakeCase(this.terraformMetaArguments),
      this.rawOverrides,
    );

    attributes["//"] = {
      ...(attributes["//"] ?? {}),
      ...this.constructNodeMetadata,
    };

    return {
      ephemeral: {
        [this.terraformResourceType]: {
          [this.friendlyUniqueId]: attributes,
        },
      },
    };
  }

  public toHclTerraform(): any {
    const attributes = deepMerge(
      processDynamicAttributesForHcl(this.synthesizeHclAttributes()),
      keysToSnakeCase(this.terraformMetaArguments),
      this.rawOverrides,
    );

    attributes["//"] = {
      ...(attributes["//"] ?? {}),
      ...this.constructNodeMetadata,
    };

    return {
      ephemeral: {
        [this.terraformResourceType]: {
          [this.friendlyUniqueId]: attributes,
        },
      },
    };
  }

  public toMetadata(): any {
    return {
      overrides: Object.keys(this.rawOverrides).length
        ? {
            [this.terraformResourceType]: Object.keys(this.rawOverrides),
          }
        : undefined,
    };
  }

  public interpolationForAttribute(terraformAttribute: string) {
    return ref(
      `ephemeral.${this.terraformResourceType}.${this.friendlyUniqueId}${
        this.forEach ? ".*" : ""
      }.${terraformAttribute}`,
      this.cdktfStack,
    );
  }
}
