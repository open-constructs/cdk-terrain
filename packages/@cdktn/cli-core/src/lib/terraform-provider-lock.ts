/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import path from "path";
import fs from "fs/promises";
import { ProviderConstraint } from "./dependencies/dependency-manager";
import { PUBLIC_REGISTRIES, Registry, logger } from "@cdktn/commons";

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

/**
 * Lock-file addresses that can satisfy a `required_providers` source. A source
 * that names a host is locked under exactly that host; a bare one under the
 * registry the running CLI resolves bare sources from. If that CLI could not be
 * identified, every public registry is returned and callers stay conservative.
 */
export function lockAddressesFor(
  source: string,
  version: string | undefined,
  cliRegistry: Registry | undefined,
): ProviderConstraint[] {
  if (source.split("/").length === 3) {
    return [new ProviderConstraint(source, version)];
  }
  if (cliRegistry) {
    return [new ProviderConstraint(source, version, cliRegistry)];
  }
  return PUBLIC_REGISTRIES.map(
    (registry) => new ProviderConstraint(source, version, registry),
  );
}

/**
 * Whether `init` must refresh the lock file. Every candidate address has to be
 * locked, so an unidentified CLI refreshes rather than trusting an entry another
 * CLI wrote.
 */
export async function needsLockfileUpdate(
  required: RequiredProvider[],
  lock: TerraformProviderLock,
  cliRegistry: Registry | undefined,
): Promise<boolean> {
  for (const { source, version } of required) {
    for (const address of lockAddressesFor(source, version, cliRegistry)) {
      if (!(await lock.hasMatchingProvider(address))) {
        return true;
      }
    }
  }
  return false;
}

/** Whether a locked version no longer satisfies a requirement, needing `init -upgrade`. */
export async function needsUpgrade(
  required: RequiredProvider[],
  lock: TerraformProviderLock,
  cliRegistry: Registry | undefined,
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
      lockAddressesFor(source, version, cliRegistry).some(
        (address) => address.source === lockedConstraint.source,
      ),
    );
    // Not required by this stack, or locked for another CLI: leave it alone.
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
