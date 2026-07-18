// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { ok } from "assert";
import { Construct, IValidation } from "constructs";
import { Token } from "./tokens";
import { TerraformStack } from "./terraform-stack";
import { ref } from "./tfExpression";
import { unresolvedTokenInConstructId, unknownProviderFeature } from "./errors";
import { ValidateFeatureTargetSupport } from "./validations/target-versions";
import {
  ProviderFeature,
  providerFeatureConstraints,
  providerFeatureHints,
  providerFeatureLabels,
} from "./provider-feature-constraints";

const TERRAFORM_ELEMENT_SYMBOL = Symbol.for("cdktf/TerraformElement");

/**
 * How a `ProviderFeature` registration on an element was armed:
 *
 * - `structural`: the element's mere existence is the usage (e.g. a
 *   `TerraformEphemeralResource`'s constructor). There is no notion of the
 *   feature going unused later in the same synthesis pass, so it is armed
 *   once and never deactivated.
 * - `resolve-discovered`: usage is only known once a value is resolved
 *   during synthesis (e.g. a write-only attribute wrapped by
 *   `markWriteOnlyAttribute`). Because the same element can be resolved
 *   across many synthesis passes over its lifetime (tests reusing a
 *   construct tree, repeated `app.synth()` calls against the same App),
 *   this kind of registration must be reset at the start of each pass and
 *   only re-armed if resolution actually rediscovers the usage during that
 *   pass - see `_resetResolveDiscoveredProviderFeatureUsage`.
 */
type ProviderFeatureRegistrationMode = "structural" | "resolve-discovered";

/**
 * `constructs` has no `removeValidation`, so a validation installed via
 * `node.addValidation` stays installed for the lifetime of the node. To let
 * a resolve-discovered registration go quiet again (see
 * `ProviderFeatureRegistrationMode`), the installed `IValidation` is this
 * thin, mutable gate: while `active` is false it reports no errors at all,
 * regardless of what the wrapped `ValidateFeatureTargetSupport` would say.
 */
class GatedFeatureValidation implements IValidation {
  public active = true;

  constructor(private readonly delegate: ValidateFeatureTargetSupport) {}

  public validate(): string[] {
    return this.active ? this.delegate.validate() : [];
  }
}

interface ProviderFeatureRegistration {
  readonly mode: ProviderFeatureRegistrationMode;
  readonly validation: GatedFeatureValidation;
}

export interface TerraformElementMetadata {
  readonly path: string;
  readonly uniqueId: string;
  readonly stackTrace: string[];
}

// eslint-disable-next-line jsdoc/require-jsdoc
export class TerraformElement extends Construct {
  protected readonly rawOverrides: any = {};

  /**
   * An explicit logical ID provided by `overrideLogicalId`.
   */
  private _logicalIdOverride?: string;

  /**
   * Type of this element, used for fqn.
   * This is undefined for
   * - elements not referable, like TerraformOutput
   * - elements using their own fqn implementation, like TerraformProvider
   */
  private readonly _elementType?: string;

  /**
   * Provider-protocol feature families (see `ProviderFeature`) already
   * registered on this element via `registerProviderFeatureUsage` or
   * `_registerResolveDiscoveredProviderFeatureUsage`, so repeated usage
   * (e.g. a setter called multiple times, or the same value resolved more
   * than once in a synthesis pass) doesn't stack duplicate synth-time
   * validations - each feature installs at most one node validation for
   * the lifetime of the element, gated on/off via the registration's
   * `active` flag instead of being re-added or removed.
   */
  private readonly _registeredProviderFeatures = new Map<
    ProviderFeature,
    ProviderFeatureRegistration
  >();

  constructor(scope: Construct, id: string, elementType?: string) {
    super(scope, id);
    Object.defineProperty(this, TERRAFORM_ELEMENT_SYMBOL, { value: true });
    this._elementType = elementType;

    if (Token.isUnresolved(id)) {
      throw unresolvedTokenInConstructId(id);
    }

    this.node.addMetadata("stacktrace", "trace");
  }

  public get cdktfStack(): TerraformStack {
    return TerraformStack.of(this);
  }

  public static isTerraformElement(x: any): x is TerraformElement {
    return x !== null && typeof x === "object" && TERRAFORM_ELEMENT_SYMBOL in x;
  }

  /**
   * Registers a synth-time validation that the project's declared
   * targetVersions admit the given provider-protocol feature family.
   * Called by generated provider bindings when a versioned feature is
   * structurally in use - the element's existence in the construct tree
   * already implies the feature is used, e.g. constructing a
   * `TerraformEphemeralResource` at all - so, unlike
   * `_registerResolveDiscoveredProviderFeatureUsage`, this registration is
   * never deactivated by `_resetResolveDiscoveredProviderFeatureUsage`. Not
   * intended to be called directly by user code. Lives on `TerraformElement`
   * (rather than `TerraformResource`) so it covers any element subclass
   * that needs it.
   */
  protected registerProviderFeatureUsage(feature: ProviderFeature): void {
    this._registerProviderFeature(feature, "structural");
  }

  /**
   * Registers (or re-arms) a synth-time validation for a provider-protocol
   * feature family whose usage is only known once a value is resolved
   * during synthesis - e.g. `markWriteOnlyAttribute`'s wrapper, which calls
   * this from its `resolve()` closure only when the resolved value turns
   * out to be a real, renderable value.
   *
   * Unlike `registerProviderFeatureUsage`, a registration made through this
   * method represents usage discovered during the CURRENT synthesis pass
   * only: `_resetResolveDiscoveredProviderFeatureUsage` deactivates it at
   * the start of each pass, and calling this method again re-activates it
   * without installing a second, duplicate node validation. Every
   * validation-enabled entry point (`App.synth`, `Testing.synth`/
   * `synthHcl` with validations, `StackSynthesizer.synthesize`) runs a
   * prepare step that performs this reset-then-rediscover cycle before
   * validations run, so what a validation sees always reflects only the
   * pass that is about to be validated.
   *
   * @internal
   */
  public _registerResolveDiscoveredProviderFeatureUsage(
    feature: ProviderFeature,
  ): void {
    this._registerProviderFeature(feature, "resolve-discovered");
  }

  /**
   * Deactivates every `resolve-discovered` provider-feature registration on
   * this element (structural registrations are left untouched - see
   * `ProviderFeatureRegistrationMode`). Called once per synthesis pass,
   * before that pass's preparing resolve re-discovers whatever usage
   * actually renders during it - see `TerraformStack._runPreparingResolve`.
   *
   * @internal
   */
  public _resetResolveDiscoveredProviderFeatureUsage(): void {
    for (const registration of this._registeredProviderFeatures.values()) {
      if (registration.mode === "resolve-discovered") {
        registration.validation.active = false;
      }
    }
  }

  private _registerProviderFeature(
    feature: ProviderFeature,
    mode: ProviderFeatureRegistrationMode,
  ): void {
    const existing = this._registeredProviderFeatures.get(feature);
    if (existing) {
      // Already installed on this element: (re-)activate it rather than
      // stacking a second node validation for the same feature.
      existing.validation.active = true;
      return;
    }

    if (
      !Object.prototype.hasOwnProperty.call(providerFeatureConstraints, feature)
    ) {
      throw unknownProviderFeature(feature);
    }

    const constraints = providerFeatureConstraints[feature];
    const hint = `${providerFeatureHints[feature]} are available in ${Object.entries(
      constraints,
    )
      .map(([product, range]) => `${product} ${range}`)
      .join(" and ")}.`;

    const validation = new GatedFeatureValidation(
      new ValidateFeatureTargetSupport(
        this,
        providerFeatureLabels[feature],
        constraints,
        hint,
      ),
    );

    this._registeredProviderFeatures.set(feature, { mode, validation });
    this.node.addValidation(validation);
  }

  public toTerraform(): any {
    return {};
  }

  public toHclTerraform(): any {
    return {};
  }

  public toMetadata(): any {
    return {};
  }

  private _fqnToken?: string;

  public get fqn() {
    if (!this._fqnToken) {
      ok(!!this._elementType, "Element type not set");
      this._fqnToken = Token.asString(
        ref(`${this._elementType}.${this.friendlyUniqueId}`, this.cdktfStack),
      );
    }
    return this._fqnToken;
  }

  private _friendlyUniqueId?: string;

  public get friendlyUniqueId() {
    if (!this._friendlyUniqueId) {
      if (this._logicalIdOverride) {
        this._friendlyUniqueId = this._logicalIdOverride;
      } else {
        this._friendlyUniqueId = this.cdktfStack.getLogicalId(this);
      }
    }
    return this._friendlyUniqueId;
  }
  /**
   * Overrides the auto-generated logical ID with a specific ID.
   * @param newLogicalId The new logical ID to use for this stack element.
   */
  public overrideLogicalId(newLogicalId: string) {
    ok(
      !this._fqnToken,
      "Logical ID may not be overridden once .fqn has been requested. Make sure to override the id before passing the construct to other constructs.",
    );
    this._logicalIdOverride = newLogicalId;
  }

  /**
   * Resets a previously passed logical Id to use the auto-generated logical id again
   */
  public resetOverrideLogicalId() {
    ok(
      !this._fqnToken,
      "Logical ID may not be overridden once .fqn has been requested. You can only reset the override before you pass the construct to other constructs.",
    );
    this._logicalIdOverride = undefined;
  }

  public addOverride(path: string, value: any) {
    const parts = path.split(".");
    let curr: any = this.rawOverrides;

    while (parts.length > 1) {
      const key = parts.shift()!;

      // if we can't recurse further or the previous value is not an
      // object overwrite it with an object.
      const isObject =
        curr[key] != null &&
        typeof curr[key] === "object" &&
        !Array.isArray(curr[key]);
      if (!isObject) {
        curr[key] = {};
      }

      curr = curr[key];
    }

    const lastKey = parts.shift()!;
    curr[lastKey] = value;
  }

  protected get constructNodeMetadata(): { [key: string]: any } {
    return {
      metadata: {
        path: this.node.path,
        uniqueId: this.friendlyUniqueId,
        stackTrace: this.node.metadata.find((e) => e.type === "stacktrace")
          ?.trace,
      } as TerraformElementMetadata,
    };
  }
}
