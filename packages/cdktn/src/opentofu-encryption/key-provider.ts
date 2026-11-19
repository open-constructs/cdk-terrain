// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { invalidOpenTofuEncryptionIdentifier } from "../errors";

const KEY_PROVIDER_SYMBOL = Symbol.for("cdktf/OpenTofuKeyProvider");

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * An attribute, key provider or method that needs a newer OpenTofu than encryption itself.
 * @internal
 */
export interface Requirement {
  readonly feature: string;
  readonly opentofu: string;
}

/**
 * Settings every OpenTofu key provider accepts.
 */
export interface OpenTofuKeyProviderBaseConfig {
  /**
   * The key under which the key provider's metadata is stored, so that it survives renaming the key provider. Needs
   * OpenTofu 1.9 or later.
   *
   * @default - the key provider's type and name
   */
  readonly encryptedMetadataAlias?: string;
}

/**
 * A key provider for {@link OpenTofuEncryption}. The key providers that the encryption's methods use are written to
 * the `encryption` block, so they don't need to be added anywhere. Each type OpenTofu ships has its own class, such
 * as {@link OpenTofuPbkdf2KeyProvider}.
 */
export class OpenTofuKeyProvider {
  /**
   * A key provider of any type, with its attributes written as given. Nested objects are written as object
   * attributes, not blocks, and key providers as references to them.
   * @param type - the key provider type, e.g. `aws_kms`
   * @param name - a name for the key provider, unique among key providers of the same type
   * @param config - the key provider's attributes, named as in the OpenTofu documentation
   * @returns the key provider
   */
  public static custom(
    type: string,
    name: string,
    config: { [key: string]: any } = {},
  ): OpenTofuKeyProvider {
    return new OpenTofuKeyProvider(type, name, config);
  }

  /**
   * A key provider that is declared outside the stack, e.g. in the `TF_ENCRYPTION` environment variable, so it is
   * referenced but not written.
   * @param type - the key provider type
   * @param name - the key provider's name
   * @returns the key provider
   */
  public static fromEnvironment(
    type: string,
    name: string,
  ): OpenTofuKeyProvider {
    return new OpenTofuKeyProvider(type, name);
  }

  /**
   * The key provider type, e.g. `pbkdf2`.
   */
  public readonly type: string;

  /**
   * The key provider's name.
   */
  public readonly name: string;

  /**
   * The attributes, or undefined if the key provider is declared outside the stack.
   * @internal
   */
  public readonly _config?: { [key: string]: any };

  /**
   * @internal
   */
  public readonly _requires: Requirement[] = [];

  /**
   * @param type - the key provider type
   * @param name - a name for the key provider, unique among key providers of the same type
   * @param config - the key provider's attributes, named as OpenTofu names them; undefined for a key provider that is
   * declared outside the stack
   */
  protected constructor(
    type: string,
    name: string,
    config?: { [key: string]: any },
  ) {
    checkIdentifier(type);
    checkIdentifier(name);
    this.type = type;
    this.name = name;
    this._config = config;
    Object.defineProperty(this, KEY_PROVIDER_SYMBOL, { value: true });
  }
}

/**
 * Checks whether the value is an {@link OpenTofuKeyProvider}.
 * @param value - any value
 * @returns true for a key provider
 */
export function isKeyProvider(value: any): value is OpenTofuKeyProvider {
  return (
    typeof value === "object" && value !== null && KEY_PROVIDER_SYMBOL in value
  );
}

/**
 * Throws unless the value can be written unquoted in a reference.
 * @param value - a key provider or method type or name
 */
export function checkIdentifier(value: string): void {
  if (!IDENTIFIER.test(value)) {
    throw invalidOpenTofuEncryptionIdentifier(value);
  }
}

/**
 * The requirements every key provider's config can add.
 * @param config - the config
 * @returns the requirements
 */
export function requirementsOf(
  config: OpenTofuKeyProviderBaseConfig,
): Requirement[] {
  return config.encryptedMetadataAlias !== undefined
    ? [
        {
          feature: "The encrypted_metadata_alias attribute",
          opentofu: ">=1.9.0",
        },
      ]
    : [];
}

/**
 * Picks fields from a typed config, in a fixed order and named as OpenTofu names them.
 * @param config - the config
 * @param fields - the fields, in the order they are written
 * @returns the attributes
 */
export function attributes<T extends object>(
  config: T,
  fields: (keyof T & string)[],
): { [key: string]: any } {
  return Object.fromEntries(
    fields.map((field) => [
      field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
      config[field],
    ]),
  );
}
