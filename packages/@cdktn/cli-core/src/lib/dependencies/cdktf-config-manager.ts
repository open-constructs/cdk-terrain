// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  Registry,
  TerraformDependencyConstraint,
  registryForTargetVersions,
} from "@cdktn/commons";
import { CdktfConfig } from "../cdktf-config";
import { ProviderConstraint } from "./dependency-manager";

/**
 * Drops the host when it is the project's own registry, so cdktf.json keeps the
 * short form. A source qualified with any other host stays qualified.
 */
function simplifySource(source: string, registry: Registry): string {
  const prefix = `${registry.hostname}/`;
  return source.startsWith(prefix) ? source.slice(prefix.length) : source;
}

/**
 * facilitates adding provider dependencies to cdktf.json
 */
export class CdktfConfigManager {
  private config: CdktfConfig = CdktfConfig.read();

  /** Registry an unqualified entry in this cdktf.json resolves against. */
  private get registry(): Registry {
    return registryForTargetVersions(this.config.targetVersions);
  }

  public async hasProvider(constraint: ProviderConstraint): Promise<boolean> {
    const registry = this.registry;
    return this.config.terraformProviders.some(
      (provider) =>
        ProviderConstraint.fromConfigEntry(provider, registry).source ===
        constraint.source,
    );
  }

  private async setProvider(constraint: ProviderConstraint): Promise<void> {
    const registry = this.registry;
    const isSame = (provider: string | TerraformDependencyConstraint) =>
      ProviderConstraint.fromConfigEntry(provider, registry).source ===
      constraint.source;

    // An update keeps the entry's own spelling, so a host the user wrote stays.
    const existing = this.config.terraformProviders.find(isSame);
    const source =
      typeof existing === "string"
        ? existing.split("@")[0].trim()
        : simplifySource(constraint.source, registry);

    // excluding the constraint to be added (if it already existed)
    const currentProviders = this.config.terraformProviders.filter(
      (provider) => !isSame(provider),
    );

    const provider =
      source + (constraint.version ? `@${constraint.version}` : "");

    currentProviders.push(provider);
    this.config.writeTerraformProviders(currentProviders);
  }

  public async addProvider(constraint: ProviderConstraint): Promise<void> {
    await this.setProvider(constraint);
  }

  public async updateProvider(constraint: ProviderConstraint): Promise<void> {
    await this.setProvider(constraint);
  }
}
