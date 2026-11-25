// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  attributes,
  OpenTofuKeyProvider,
  OpenTofuKeyProviderBaseConfig,
  requirementsOf,
} from "../key-provider";

/**
 * Configuration for {@link OpenTofuPbkdf2KeyProvider}. Set exactly one of `passphrase` and `chain`.
 */
export interface OpenTofuPbkdf2KeyProviderConfig extends OpenTofuKeyProviderBaseConfig {
  /**
   * The passphrase, at least 16 characters long. Read it from a sensitive `TerraformVariable` instead of writing it
   * into the code.
   *
   * @default - the key comes from `chain`
   */
  readonly passphrase?: string;

  /**
   * A key provider whose output is used as the passphrase. Needs OpenTofu 1.10 or later.
   *
   * @default - the key comes from `passphrase`
   */
  readonly chain?: OpenTofuKeyProvider;

  /**
   * The length of the generated key in bytes.
   *
   * @default 32
   */
  readonly keyLength?: number;

  /**
   * The number of iterations, at least 200000.
   *
   * @default 600000
   */
  readonly iterations?: number;

  /**
   * The length of the salt in bytes.
   *
   * @default 32
   */
  readonly saltLength?: number;

  /**
   * The hash function, `sha256` or `sha512`.
   *
   * @default "sha512"
   */
  readonly hashFunction?: string;
}

/**
 * Derives a key from a passphrase.
 */
export class OpenTofuPbkdf2KeyProvider extends OpenTofuKeyProvider {
  /**
   * @param name - a name for the key provider, unique among `pbkdf2` key providers
   * @param config - the passphrase and key derivation settings
   */
  constructor(name: string, config: OpenTofuPbkdf2KeyProviderConfig) {
    super(
      "pbkdf2",
      name,
      attributes(config, [
        "passphrase",
        "chain",
        "keyLength",
        "iterations",
        "saltLength",
        "hashFunction",
        "encryptedMetadataAlias",
      ]),
    );
    this._requires.push(...requirementsOf(config));
    if (config.chain) {
      this._requires.push({
        feature: "The pbkdf2 key provider's chain attribute",
        opentofu: ">=1.10.0",
      });
    }
  }
}
