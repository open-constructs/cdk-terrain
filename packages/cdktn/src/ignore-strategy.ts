// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { excludeMatcher } from "./private/fs";

/**
 * A single entry presented to an {@link IIgnoreStrategy}.
 *
 * A struct rather than a positional `relativePath` string so the shape can
 * evolve. `isDirectory` is carried from the outset because `.gitignore` /
 * `.dockerignore` semantics turn on it: a `foo/` pattern matches a
 * directory but not a file named `foo`, and a matcher cannot recover
 * that distinction from the path text alone.
 */
export interface IgnoreQuery {
  /**
   * `/`-separated path relative to the asset root.
   */
  readonly relativePath: string;

  /**
   * Whether this entry is a directory rather than a file or symlink.
   *
   * The tree walkers set this from `lstat`, so a strategy can honor
   * directory-only patterns without stat-ing the path itself (which it has
   * no root to resolve against). Excluding a directory also excludes
   * everything below it, since the walkers stop descending once a directory
   * is excluded.
   */
  readonly isDirectory: boolean;
}

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
   * Whether the given entry should be excluded.
   * @param query - the entry under consideration, see {@link IgnoreQuery}
   */
  ignores(query: IgnoreQuery): boolean;

  /**
   * Whether excluding a directory also excludes everything beneath it.
   *
   * When `true` (the default), the walkers stop descending as soon as a
   * directory is excluded — cheaper, and correct for a strategy whose
   * patterns never re-include a path below an excluded parent.
   *
   * A strategy with negation patterns must set this to `false`:
   * `.gitignore` / `.dockerignore` allow `node_modules` followed by
   * `!node_modules/keep`, which is only reachable if the walk descends into
   * the excluded `node_modules` and asks about `node_modules/keep`. The
   * excluded directory entry itself is still omitted; only the descent
   * changes. Opting out costs a full walk of excluded subtrees.
   *
   * @default true
   */
  readonly pruneExcludedDirectories?: boolean;

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

  // Undefined (the interface default) prunes excluded directories, which is
  // correct here since the built-in patterns have no negation form.
  public readonly pruneExcludedDirectories?: boolean;

  constructor(exclude: string[]) {
    this.matcher = excludeMatcher(exclude);
    this.cacheKey = `exclude:${JSON.stringify(exclude)}`;
  }

  public ignores(query: IgnoreQuery): boolean {
    // Path-based matching only; `isDirectory` is unused.
    return this.matcher(query.relativePath);
  }
}
