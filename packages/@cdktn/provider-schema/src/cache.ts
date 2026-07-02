/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { ConstructsMakerTarget, logger, Errors } from "@cdktn/commons";
import * as fs from "fs-extra";
import * as path from "path";

// We keep this very simple since the caching feature is experimental
// we might need to do housekeeping / include terraform / cdktf version in the future
//
// keySuffix distinguishes cache entries fetched by different CLIs/versions
// (e.g. "terraform-1.7") so a schema fetched by a CLI too old to emit newer
// sections (functions, ephemeral resources, ...) isn't served up as if it
// were a complete fetch. See read.ts.
function cacheKey(input: ConstructsMakerTarget, keySuffix?: string): string {
  const base = `${encodeURIComponent(input.fqn)}@${encodeURIComponent(
    input.version || "",
  )}`;
  return keySuffix ? `${base}@${encodeURIComponent(keySuffix)}` : base;
}

export function cachedAccess<I extends ConstructsMakerTarget, O>(
  producer: (input: I) => Promise<O>,
  cacheDir?: string | null,
  keySuffix?: string,
): (input: I) => Promise<O> {
  const cacheEnabled = typeof cacheDir === "string" && cacheDir.length > 0;

  if (cacheEnabled && !fs.lstatSync(cacheDir as string).isDirectory()) {
    throw Errors.Usage(
      `Provider Schema Cache directory '${cacheDir}' is not a directory`,
    );
  }

  if (!cacheEnabled) {
    logger.debug(`Provider Schema Cache disabled`);
    return (input) => {
      return producer(input);
    };
  }

  logger.debug(`Provider Schema Cache enabled, caching at ${cacheDir}`);
  return async (input) => {
    const key = cacheKey(input, keySuffix);
    const cachePath = path.join(cacheDir, `${key}.json`);
    if (fs.existsSync(cachePath)) {
      logger.debug(`Cache hit for ${key}`);
      return JSON.parse(await fs.readFile(cachePath, "utf-8")) as O;
    }
    logger.debug(`Cache miss for ${key}, generating schema`);

    const result = await producer(input);
    await fs.writeFile(cachePath, JSON.stringify(result));
    logger.debug(`Write cache for ${key}`);
    return result;
  };
}
