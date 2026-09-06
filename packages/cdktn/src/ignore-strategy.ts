// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { excludeMatcher } from "./private/fs";

/**
 * Decides whether a path relative to an asset root is excluded from staging
 * and hashing.
 *
 * Core ships only the exact-path / `*.ext` / directory matcher used by
 * `exclude` today (`ExcludeIgnoreStrategy`). Full glob, `.gitignore`, and
 * `.dockerignore` parity can be implemented against this interface without
 * core taking on a glob parser.
 */
export interface IIgnoreStrategy {
  /**
   * Whether the given path should be excluded.
   * @param relativePath - `/`-separated path relative to the asset root
   */
  ignores(relativePath: string): boolean;

  /**
   * A value identifying this strategy's exclusion behavior, suitable for
   * folding into a cache key. Two strategies that return the same
   * `cacheKey` must exclude the same paths.
   *
   * Callers such as `AssetStaging`'s result cache key on a JSON-serializable
   * representation of their inputs, which a strategy instance is not. Omit
   * this when the strategy's behavior can't be summarized this way; the
   * caller then has to treat every call as uncacheable.
   *
   * @default - this strategy cannot be represented in a cache key
   */
  readonly cacheKey?: string;
}

/**
 * The default ignore strategy: exact paths, `*.ext` suffixes, and
 * directories (with everything inside them).
 */
export class ExcludeIgnoreStrategy implements IIgnoreStrategy {
  private readonly matcher: (relativePath: string) => boolean;

  public readonly cacheKey?: string;

  constructor(exclude: string[]) {
    this.matcher = excludeMatcher(exclude);
    this.cacheKey = `exclude:${JSON.stringify(exclude)}`;
  }

  public ignores(relativePath: string): boolean {
    return this.matcher(relativePath);
  }
}
