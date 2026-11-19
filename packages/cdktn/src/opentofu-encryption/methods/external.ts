// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import type { OpenTofuKeyProvider } from "../key-provider";
import { attributes, Requirement } from "../key-provider";
import { OpenTofuEncryptionMethod } from "../method";

const EXTERNAL: Requirement = {
  feature: "The external encryption method",
  opentofu: ">=1.10.0",
};

/**
 * Configuration for {@link OpenTofuExternalMethod}.
 */
export interface OpenTofuExternalMethodConfig {
  /**
   * The program that encrypts, and its arguments. It follows OpenTofu's external method protocol.
   */
  readonly encryptCommand: string[];

  /**
   * The program that decrypts, and its arguments.
   */
  readonly decryptCommand: string[];

  /**
   * A key provider whose key is passed to the programs.
   *
   * @default - no key
   */
  readonly keys?: OpenTofuKeyProvider;
}

/**
 * Encrypts with programs you provide. Needs OpenTofu 1.10 or later.
 */
export class OpenTofuExternalMethod extends OpenTofuEncryptionMethod {
  /**
   * @param name - a name for the method, unique among `external` methods
   * @param config - the programs, and an optional key provider whose key they get
   */
  constructor(name: string, config: OpenTofuExternalMethodConfig) {
    super(
      "external",
      name,
      attributes(config, ["keys", "encryptCommand", "decryptCommand"]),
    );
    this._requires.push(EXTERNAL);
  }
}
