// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  attributes,
  OpenTofuKeyProvider,
  OpenTofuKeyProviderBaseConfig,
  Requirement,
  requirementsOf,
} from "../key-provider";

const AZURE_VAULT: Requirement = {
  feature: "The azure_vault key provider",
  opentofu: ">=1.11.0",
};

/**
 * Configuration for {@link OpenTofuAzureVaultKeyProvider}. Credentials come from the usual Azure environment
 * variables unless they are set here; read secrets from a sensitive `TerraformVariable`.
 */
export interface OpenTofuAzureVaultKeyProviderConfig extends OpenTofuKeyProviderBaseConfig {
  /**
   * The Key Vault's URI, e.g. `https://<vault>.vault.azure.net`.
   */
  readonly vaultUri: string;

  /**
   * The name of the key in the vault.
   */
  readonly vaultKeyName: string;

  /**
   * The length of the generated key in bytes, e.g. 32 for `aes_gcm`.
   */
  readonly keyLength: number;

  /**
   * Whether the vault key is a symmetric key, which needs a Managed HSM.
   *
   * @default false
   */
  readonly symmetric?: boolean;

  /**
   * The size of a symmetric vault key in bits.
   *
   * @default - set by OpenTofu
   */
  readonly symmetricKeySize?: number;

  /**
   * The tenant ID.
   *
   * @default - from the environment
   */
  readonly tenantId?: string;

  /**
   * The subscription ID.
   *
   * @default - from the environment
   */
  readonly subscriptionId?: string;

  /**
   * The cloud environment, e.g. `public` or `usgovernment`.
   *
   * @default "public"
   */
  readonly environment?: string;

  /**
   * The host to read the cloud environment's metadata from.
   *
   * @default - none
   */
  readonly metadataHost?: string;

  /**
   * Whether to authenticate with the Azure CLI.
   *
   * @default true
   */
  readonly useCli?: boolean;

  /**
   * The client ID of a service principal.
   *
   * @default - from the environment
   */
  readonly clientId?: string;

  /**
   * A file containing the client ID.
   *
   * @default - none
   */
  readonly clientIdFilePath?: string;

  /**
   * The client secret of a service principal.
   *
   * @default - from the environment
   */
  readonly clientSecret?: string;

  /**
   * A file containing the client secret.
   *
   * @default - none
   */
  readonly clientSecretFilePath?: string;

  /**
   * A client certificate, base64-encoded.
   *
   * @default - none
   */
  readonly clientCertificate?: string;

  /**
   * The password of the client certificate.
   *
   * @default - none
   */
  readonly clientCertificatePassword?: string;

  /**
   * A file containing the client certificate.
   *
   * @default - none
   */
  readonly clientCertificatePath?: string;

  /**
   * Whether to authenticate with OpenID Connect.
   *
   * @default false
   */
  readonly useOidc?: boolean;

  /**
   * The OpenID Connect token.
   *
   * @default - from the environment
   */
  readonly oidcToken?: string;

  /**
   * A file containing the OpenID Connect token.
   *
   * @default - none
   */
  readonly oidcTokenFilePath?: string;

  /**
   * The URL to request an OpenID Connect token from.
   *
   * @default - from the environment
   */
  readonly oidcRequestUrl?: string;

  /**
   * The bearer token for `oidcRequestUrl`.
   *
   * @default - from the environment
   */
  readonly oidcRequestToken?: string;

  /**
   * Whether to authenticate with a managed identity.
   *
   * @default false
   */
  readonly useMsi?: boolean;

  /**
   * The managed identity endpoint.
   *
   * @default - the default endpoint
   */
  readonly msiEndpoint?: string;

  /**
   * Whether to authenticate with AKS workload identity.
   *
   * @default false
   */
  readonly useAksWorkloadIdentity?: boolean;
}

/**
 * Generates keys with Azure Key Vault. Needs OpenTofu 1.11 or later.
 */
export class OpenTofuAzureVaultKeyProvider extends OpenTofuKeyProvider {
  /**
   * @param name - a name for the key provider, unique among `azure_vault` key providers
   * @param config - the vault key and the Azure settings
   */
  constructor(name: string, config: OpenTofuAzureVaultKeyProviderConfig) {
    super(
      "azure_vault",
      name,
      attributes(config, [
        "vaultUri",
        "vaultKeyName",
        "keyLength",
        "symmetric",
        "symmetricKeySize",
        "tenantId",
        "subscriptionId",
        "environment",
        "metadataHost",
        "useCli",
        "clientId",
        "clientIdFilePath",
        "clientSecret",
        "clientSecretFilePath",
        "clientCertificate",
        "clientCertificatePassword",
        "clientCertificatePath",
        "useOidc",
        "oidcToken",
        "oidcTokenFilePath",
        "oidcRequestUrl",
        "oidcRequestToken",
        "useMsi",
        "msiEndpoint",
        "useAksWorkloadIdentity",
        "encryptedMetadataAlias",
      ]),
    );
    this._requires.push(AZURE_VAULT, ...requirementsOf(config));
  }
}
