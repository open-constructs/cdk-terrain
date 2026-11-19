// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import type { OpenTofuKeyProvider } from "../key-provider";
import { OpenTofuEncryptionMethod } from "../method";

/**
 * Configuration for {@link OpenTofuAesGcmMethod}.
 */
export interface OpenTofuAesGcmMethodConfig {
  /**
   * The key provider the method encrypts with. Its key must be 16, 24 or 32 bytes long.
   */
  readonly keys: OpenTofuKeyProvider;

  /**
   * Additional authenticated data, as bytes. Decryption fails unless it matches the value used for encryption.
   *
   * @default - none
   */
  readonly aad?: number[];
}

/**
 * Encrypts with AES-GCM.
 */
export class OpenTofuAesGcmMethod extends OpenTofuEncryptionMethod {
  /**
   * @param name - a name for the method, unique among `aes_gcm` methods
   * @param config - the key provider
   */
  constructor(name: string, config: OpenTofuAesGcmMethodConfig) {
    super("aes_gcm", name, { keys: config.keys, aad: config.aad });
  }
}
