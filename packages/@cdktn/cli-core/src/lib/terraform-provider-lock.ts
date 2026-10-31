/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import path from "path";
import fs from "fs/promises";
import { ProviderConstraint } from "./dependencies/dependency-manager";
import { PUBLIC_REGISTRIES, logger } from "@cdktn/commons";

const TerraformLockFileName = ".terraform.lock.hcl";

type TerraformProviderLockFileEntry = {
  name: string;
  version?: string;
  constraints?: ProviderConstraint;
};

type TerraformProviderLockFileData = {
  providers: {
    [name: string]: TerraformProviderLockFileEntry;
  };
};

type RequiredProvider = { source: string; version?: string };

// A source that names a host is locked under exactly that host. A bare one is
// locked under whichever public registry the CLI resolved it from, so either
// counts: OpenTofu migrates a Terraform entry itself on init.
function lockAddressesFor(
  source: string,
  version?: string,
): ProviderConstraint[] {
  if (source.split("/").length === 3) {
    return [new ProviderConstraint(source, version)];
  }
  return PUBLIC_REGISTRIES.map(
    (registry) => new ProviderConstraint(source, version, registry),
  );
}

/** Whether `init` should be followed by a `providers lock` refresh. */
export async function needsLockfileUpdate(
  required: RequiredProvider[],
  lock: TerraformProviderLock,
): Promise<boolean> {
  for (const { source, version } of required) {
    let locked = false;
    for (const address of lockAddressesFor(source, version)) {
      if (await lock.hasMatchingProvider(address)) {
        locked = true;
        break;
      }
    }
    if (!locked) {
      return true;
    }
  }
  return false;
}

/** Whether a locked version no longer satisfies a requirement, needing `init -upgrade`. */
export async function needsUpgrade(
  required: RequiredProvider[],
  lock: TerraformProviderLock,
): Promise<boolean> {
  const lockedProviders = Object.values(await lock.providers());
  return lockedProviders.some((lockedProvider) => {
    const lockedConstraint = lockedProvider.constraints;
    if (!lockedConstraint) {
      // Provider lock doesn't have a constraint specified, so we can't check.
      logger.debug(
        `Provider lock doesn't have a constraint for ${lockedProvider.name}`,
      );
      return false;
    }

    const provider = required.find(({ source, version }) =>
      lockAddressesFor(source, version).some(
        (address) => address.source === lockedConstraint.source,
      ),
    );
    // No longer required by this stack, so it can't block the upgrade.
    if (!provider) {
      return false;
    }

    return !lockedConstraint.matchesVersion(provider.version ?? ">0");
  });
}

export class TerraformProviderLock {
  private _providerLockData: TerraformProviderLockFileData | null;
  constructor(private stackWorkingDirectory: string) {
    this._providerLockData = null;
  }

  private get lockFilePath() {
    return path.join(this.stackWorkingDirectory, TerraformLockFileName);
  }

  public async hasProviderLockFile() {
    try {
      await fs.stat(this.lockFilePath);
      return true;
    } catch {
      return false;
    }
  }

  private async readProviderLockFile() {
    try {
      const lockFile = (await fs.readFile(this.lockFilePath)).toString();

      return lockFile;
    } catch (e) {
      logger.debug("Unable to read provider lock file", e);
    }

    return "";
  }

  private parseProviderLockFile(contents: string) {
    const providerLockData: TerraformProviderLockFileData = {
      providers: {},
    };
    let currentProvider: string | undefined;

    contents.split(/\r\n|\r|\n/).forEach((line) => {
      if (currentProvider) {
        const constraintMatch = line.match(/^\s*constraints\s+=\s+"(.*)"/);
        if (constraintMatch) {
          providerLockData.providers[currentProvider].constraints =
            new ProviderConstraint(currentProvider, constraintMatch[1]);
          return;
        }

        const versionMatch = line.match(/^\s*version\s+=\s+"(.*)"/);
        if (versionMatch) {
          providerLockData.providers[currentProvider].version = versionMatch[1];
          return;
        }

        const endMatch = line.match(/^\s*}/);
        if (endMatch) {
          currentProvider = undefined;
        }

        return;
      }

      const providerMatch = line.match(/provider "(.*)"/);
      if (providerMatch) {
        currentProvider = providerMatch[1];
        providerLockData.providers[currentProvider] = {
          name: new ProviderConstraint(currentProvider, ">=0").simplifiedName,
        };
      }
    });

    return providerLockData;
  }

  public async providers(forceReread = false) {
    if (!this._providerLockData || forceReread) {
      const contents = await this.readProviderLockFile();
      this._providerLockData = this.parseProviderLockFile(contents);
    }

    return this._providerLockData.providers;
  }

  public async hasMatchingProvider(constraint: ProviderConstraint) {
    const providerLockData = await this.providers();
    const lockedProvider = providerLockData[constraint.source];
    if (lockedProvider) {
      return lockedProvider.constraints?.matchesVersion(
        constraint.version ?? ">0",
      );
    }

    return false;
  }
}
