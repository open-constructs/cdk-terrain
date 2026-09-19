// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TerraformTargetVersions } from "./config";

/** A provider registry and the URL shapes that go with it. */
export interface Registry {
  /** Hostname used to resolve providers declared without one. */
  readonly hostname: string;
  /** Where to send a user looking for available providers. */
  readonly browseUrl: string;
  /**
   * Documentation link for one generated construct. `kind` "provider" ignores
   * `name`. Returns the provider page when the registry has no page for the
   * kind, which is the case for OpenTofu and ephemeral resources.
   */
  docsUrl(
    namespace: string,
    provider: string,
    version: string,
    kind: "provider" | "resource" | "data-source" | "ephemeral-resource",
    name?: string,
  ): string;
}

export const TERRAFORM_REGISTRY: Registry = {
  hostname: "registry.terraform.io",
  browseUrl: "https://registry.terraform.io/browse/providers",
  docsUrl(namespace, provider, version, kind, name) {
    const base = `https://registry.terraform.io/providers/${namespace}/${provider}/${version}/docs`;
    switch (kind) {
      case "provider":
        return base;
      case "resource":
        return `${base}/resources/${name}`;
      case "data-source":
        return `${base}/data-sources/${name}`;
      case "ephemeral-resource":
        return `${base}/ephemeral-resources/${name}`;
    }
  },
};

// Paths follow getDocumentationUrl.ts in opentofu/registry-ui: /provider/
// singular, a v-prefixed version, and "datasources" unhyphenated. That UI has
// no ephemeral-resource route yet (opentofu/registry-ui#348), so those fall
// back to the provider page.
export const OPENTOFU_REGISTRY: Registry = {
  hostname: "registry.opentofu.org",
  browseUrl: "https://search.opentofu.org/providers",
  docsUrl(namespace, provider, version, kind, name) {
    const base = `https://search.opentofu.org/provider/${namespace}/${provider}/v${version}/docs`;
    switch (kind) {
      case "provider":
      case "ephemeral-resource":
        return base;
      case "resource":
        return `${base}/resources/${name}`;
      case "data-source":
        return `${base}/datasources/${name}`;
    }
  },
};

/**
 * The registry a project targets, from its declared `targetVersions`.
 *
 * OpenTofu only when it is the sole declared product. Declaring both, or
 * declaring nothing (DEFAULT_TARGET_VERSIONS declares both), gives Terraform -
 * so output does not depend on which CLI happened to run.
 */
export function registryForTargetVersions(
  targetVersions?: TerraformTargetVersions,
): Registry {
  const opentofuOnly =
    targetVersions?.opentofu !== undefined &&
    targetVersions?.terraform === undefined;
  return opentofuOnly ? OPENTOFU_REGISTRY : TERRAFORM_REGISTRY;
}
