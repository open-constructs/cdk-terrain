// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as path from "path";
import * as fs from "fs";
import { Construct } from "constructs";
import { TerraformStack } from "./terraform-stack";
import { addCustomSynthesis } from "./synthesize/synthesizer";
import { ISynthesisSession } from "./synthesize/types";
import { ValidateFeatureTargetSupport } from "./validations/target-versions";
import {
  productSettingsAlreadyDefined,
  productSettingsEmpty,
  productSettingsWithoutProducts,
} from "./errors";

const PRODUCT_SETTINGS_SYMBOL = Symbol.for("cdktf/TerraformProductSettings");

/**
 * Name of the file, in the stack's working directory, that holds the Terraform settings. Terraform reads every
 * `.tf.json` file in the directory. OpenTofu also reads it unless {@link OPENTOFU_SETTINGS_FILE} is present.
 */
export const TERRAFORM_SETTINGS_FILE = "settings.tf.json";

/**
 * Name of the file, in the stack's working directory, that holds the OpenTofu settings. OpenTofu 1.8+ loads it in
 * place of {@link TERRAFORM_SETTINGS_FILE}. Terraform never reads `.tofu.json` files.
 */
export const OPENTOFU_SETTINGS_FILE = "settings.tofu.json";

/**
 * Settings enforced only by Terraform, written to `settings.tf.json`.
 */
export interface TerraformSettings {
  /**
   * Terraform version constraint, in Terraform's version constraint syntax (e.g. "~> 1.9"). Written verbatim as
   * `terraform.required_version`, so Terraform validates the syntax at `init`.
   *
   * OpenTofu 1.8–1.11 also enforces this constraint unless {@link TerraformProductSettingsConfig.opentofu} is set.
   *
   * @default - no Terraform version constraint
   */
  readonly requiredVersion?: string;
}

/**
 * Settings enforced only by OpenTofu, written to `settings.tofu.json`.
 */
export interface OpenTofuSettings {
  /**
   * OpenTofu version constraint, in Terraform's version constraint syntax (e.g. "~> 1.8"). Written verbatim as
   * `terraform.required_version`, so OpenTofu validates the syntax at `init`.
   *
   * Enforced by OpenTofu 1.8 and later, including 1.12+, which only reads `required_version` from `.tofu` files.
   *
   * @default - no OpenTofu version constraint
   */
  readonly requiredVersion?: string;
}

/**
 * Per-product settings for Terraform and OpenTofu. At least one product must be set, and each product that is set
 * must have at least one setting.
 */
export interface TerraformProductSettingsConfig {
  /**
   * Settings applied only by Terraform, written to `settings.tf.json`.
   *
   * @default - `settings.tf.json` is not written
   */
  readonly terraform?: TerraformSettings;

  /**
   * Settings applied only by OpenTofu, written to `settings.tofu.json`. Setting this requires the project's
   * `targetVersions.opentofu` to be `>=1.8.0` or narrower, since earlier OpenTofu releases ignore `.tofu.json` files.
   *
   * @default - `settings.tofu.json` is not written
   */
  readonly opentofu?: OpenTofuSettings;
}

/**
 * Writes settings for Terraform and OpenTofu into separate files next to the stack's configuration, so each binary
 * only applies its own settings.
 *
 * Each file is only written when its product is set. OpenTofu (1.8+) loads `settings.tofu.json` in place of
 * `settings.tf.json`, and Terraform ignores `.tofu.json` files. When only `terraform` is set, OpenTofu 1.8–1.11 reads
 * `settings.tf.json` and enforces the Terraform `required_version`; OpenTofu 1.12+ only reads `required_version` from
 * `.tofu` files.
 */
export class TerraformProductSettings extends Construct {
  /**
   * @param scope - construct scope; must be inside a {@link TerraformStack}
   * @param id - construct id
   * @param config - per-product settings, see {@link TerraformProductSettingsConfig}
   * @throws if neither product is set, if a product is set without any settings, or if the stack already contains a
   * `TerraformProductSettings`
   */
  constructor(
    scope: Construct,
    id: string,
    private readonly config: TerraformProductSettingsConfig,
  ) {
    super(scope, id);

    if (config.terraform === undefined && config.opentofu === undefined) {
      throw productSettingsWithoutProducts(this.node.path);
    }
    for (const [product, settings] of Object.entries(config)) {
      if (settings !== undefined && isEmpty(settings)) {
        throw productSettingsEmpty(this.node.path, product);
      }
    }

    const stack = TerraformStack.of(this);
    const existing = stack.node
      .findAll()
      .find(TerraformProductSettings.isTerraformProductSettings);
    if (existing) {
      throw productSettingsAlreadyDefined(stack.node.path, existing.node.path);
    }

    Object.defineProperty(this, PRODUCT_SETTINGS_SYMBOL, { value: true });

    // OpenTofu before 1.8 ignores settings.tofu.json, so the OpenTofu settings would never apply
    if (config.opentofu !== undefined) {
      this.node.addValidation(
        new ValidateFeatureTargetSupport(
          this,
          "TerraformProductSettings",
          { terraform: "*", opentofu: ">=1.8.0" },
          `Set targetVersions.opentofu to ">=1.8.0" in cdktf.json.`,
        ),
      );
    }

    addCustomSynthesis(this, {
      onSynthesize: this._onSynthesize.bind(this),
    });
  }

  /**
   * Checks whether `x` is a `TerraformProductSettings`. Uses a shared symbol rather than `instanceof`, so it also
   * recognises instances created by another copy of the cdktn library.
   * @param x - value to check
   * @returns true if `x` is a `TerraformProductSettings`
   */
  public static isTerraformProductSettings(
    x: any,
  ): x is TerraformProductSettings {
    return x !== null && typeof x === "object" && PRODUCT_SETTINGS_SYMBOL in x;
  }

  /**
   * Writes the settings file for each product that is set into the stack's working directory. Leftover files from a
   * previous synth are removed beforehand by the stack synthesizer.
   * @param session - the synthesis session, used to locate the stack's working directory
   */
  private _onSynthesize(session: ISynthesisSession) {
    const stackManifest = session.manifest.forStack(TerraformStack.of(this));
    const workingDirectory = path.join(
      session.outdir,
      stackManifest.workingDirectory,
    );

    if (this.config.terraform !== undefined) {
      writeJson(
        path.join(workingDirectory, TERRAFORM_SETTINGS_FILE),
        settingsBlock(this.config.terraform),
      );
    }

    if (this.config.opentofu !== undefined) {
      writeJson(
        path.join(workingDirectory, OPENTOFU_SETTINGS_FILE),
        settingsBlock(this.config.opentofu),
      );
    }
  }
}

/**
 * Checks whether a product's settings object sets nothing. Inspects every key, so settings added to
 * {@link TerraformSettings} or {@link OpenTofuSettings} later are covered without changes here.
 * @param settings - a product's settings object
 * @returns true if every setting is `undefined`
 */
function isEmpty(settings: object): boolean {
  return Object.values(settings).every((value) => value === undefined);
}

/**
 * Renders a product's settings as Terraform JSON configuration. Both products read `required_version` from the
 * `terraform` block.
 * @param settings - a product's settings object
 * @returns the JSON configuration body for the product's settings file
 */
function settingsBlock(settings: TerraformSettings | OpenTofuSettings) {
  return { terraform: { required_version: settings.requiredVersion } };
}

/**
 * Writes `content` to `filePath` as pretty-printed JSON, replacing any existing file.
 * @param filePath - absolute path of the file to write
 * @param content - value to serialise
 */
function writeJson(filePath: string, content: object): void {
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
}
