// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  attributes,
  OpenTofuKeyProvider,
  OpenTofuKeyProviderBaseConfig,
  requirementsOf,
} from "../key-provider";

/**
 * Configuration for {@link OpenTofuOpenBaoKeyProvider}. The address and token come from the BAO_ADDR and BAO_TOKEN
 * environment variables unless they are set here; read the token from a sensitive `TerraformVariable`.
 */
export interface OpenTofuOpenBaoKeyProviderConfig extends OpenTofuKeyProviderBaseConfig {
  /**
   * The name of the transit key.
   */
  readonly keyName: string;

  /**
   * The length of the generated key in bytes: 16, 32 or 64.
   *
   * @default 32
   */
  readonly keyLength?: number;

  /**
   * The path the transit secrets engine is mounted at.
   *
   * @default "/transit"
   */
  readonly transitEnginePath?: string;

  /**
   * The OpenBao server's address.
   *
   * @default - the BAO_ADDR environment variable
   */
  readonly address?: string;

  /**
   * The OpenBao token.
   *
   * @default - the BAO_TOKEN environment variable
   */
  readonly token?: string;
}

/**
 * Generates keys with the transit secrets engine of OpenBao.
 */
export class OpenTofuOpenBaoKeyProvider extends OpenTofuKeyProvider {
  /**
   * @param name - a name for the key provider, unique among `openbao` key providers
   * @param config - the transit key and the OpenBao settings
   */
  constructor(name: string, config: OpenTofuOpenBaoKeyProviderConfig) {
    super(
      "openbao",
      name,
      attributes(config, [
        "keyName",
        "keyLength",
        "transitEnginePath",
        "address",
        "token",
        "encryptedMetadataAlias",
      ]),
    );
    this._requires.push(...requirementsOf(config));
  }
}
