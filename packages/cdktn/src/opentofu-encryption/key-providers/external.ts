// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  attributes,
  OpenTofuKeyProvider,
  OpenTofuKeyProviderBaseConfig,
  Requirement,
  requirementsOf,
} from "../key-provider";

const EXTERNAL: Requirement = {
  feature: "The external key provider",
  opentofu: ">=1.10.0",
};

/**
 * Configuration for {@link OpenTofuExternalKeyProvider}.
 */
export interface OpenTofuExternalKeyProviderConfig extends OpenTofuKeyProviderBaseConfig {
  /**
   * The program to run and its arguments. It follows OpenTofu's external key provider protocol.
   */
  readonly command: string[];
}

/**
 * Gets keys from a program you provide. Needs OpenTofu 1.10 or later.
 */
export class OpenTofuExternalKeyProvider extends OpenTofuKeyProvider {
  /**
   * @param name - a name for the key provider, unique among `external` key providers
   * @param config - the program
   */
  constructor(name: string, config: OpenTofuExternalKeyProviderConfig) {
    super(
      "external",
      name,
      attributes(config, ["command", "encryptedMetadataAlias"]),
    );
    this._requires.push(EXTERNAL, ...requirementsOf(config));
  }
}
