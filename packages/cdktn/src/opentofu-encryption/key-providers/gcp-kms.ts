// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  attributes,
  OpenTofuKeyProvider,
  OpenTofuKeyProviderBaseConfig,
  requirementsOf,
} from "../key-provider";

/**
 * Configuration for {@link OpenTofuGcpKmsKeyProvider}. Credentials come from the usual Google Cloud environment
 * variables and files unless they are set here; read secrets from a sensitive `TerraformVariable`.
 */
export interface OpenTofuGcpKmsKeyProviderConfig extends OpenTofuKeyProviderBaseConfig {
  /**
   * The key's resource name, e.g. `projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>`.
   */
  readonly kmsEncryptionKey: string;

  /**
   * The length of the generated key in bytes, e.g. 32 for `aes_gcm`.
   */
  readonly keyLength: number;

  /**
   * A service account key file's path or contents.
   *
   * @default - from the environment
   */
  readonly credentials?: string;

  /**
   * An OAuth access token, in place of `credentials`.
   *
   * @default - from the environment
   */
  readonly accessToken?: string;

  /**
   * A service account to impersonate.
   *
   * @default - none
   */
  readonly impersonateServiceAccount?: string;

  /**
   * The delegation chain for `impersonateServiceAccount`.
   *
   * @default - none
   */
  readonly impersonateServiceAccountDelegates?: string[];
}

/**
 * Generates keys with Google Cloud KMS.
 */
export class OpenTofuGcpKmsKeyProvider extends OpenTofuKeyProvider {
  /**
   * @param name - a name for the key provider, unique among `gcp_kms` key providers
   * @param config - the KMS key and the Google Cloud settings
   */
  constructor(name: string, config: OpenTofuGcpKmsKeyProviderConfig) {
    super(
      "gcp_kms",
      name,
      attributes(config, [
        "kmsEncryptionKey",
        "keyLength",
        "credentials",
        "accessToken",
        "impersonateServiceAccount",
        "impersonateServiceAccountDelegates",
        "encryptedMetadataAlias",
      ]),
    );
    this._requires.push(...requirementsOf(config));
  }
}
