// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { strToU8, zipSync } from "fflate";
import type { ZipOptions } from "fflate";
import {
  assetCanNotCreateZipArchive,
  assetSymlinkEscapesRoot,
  assetSymlinkNeedsDeveloperMode,
} from "../errors";

const HASH_LEN = 32;

// Unix file-type bits for zip external attributes (st_mode upper nibble)
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const PERM_MASK = 0o7777;
// "version made by" host byte; unzip only honors unix mode attrs when set
const ZIP_OS_UNIX = 3;
// Pinned so archives are byte-reproducible across synths. fflate encodes
// DOS dates from local-time getters and rejects years outside 1980-2099,
// so this must be a local-time 1980 date (a UTC one underflows to 1979 in
// timezones west of UTC).
const ZIP_ENTRY_MTIME = new Date(1980, 0, 1);

/**
 * Zip external attributes for a unix mode: file-type and permission bits
 * belong in the high 16 bits of the 32-bit field.
 * @param mode - unix st_mode bits (type | permissions)
 */
function zipAttrs(mode: number): number {
  return (mode << 16) >>> 0;
}

/**
 * What {@link resolveLinkTarget} finds out about one symlink.
 */
interface LinkTarget {
  /** True when the target resolves inside the asset root. */
  readonly withinRoot: boolean;
  /**
   * The target as a `/`-separated path relative to the asset root. Only
   * meaningful when {@link withinRoot} is true.
   */
  readonly relativeToRoot: string;
  /** The target, resolved to an absolute path. */
  readonly absolute: string;
  /**
   * True when the on-disk link text is an absolute path that means the same
   * thing wherever it is read — a plain POSIX absolute link such as a Lambda
   * layer's `/opt/...` target. A Windows drive-letter (`C:\...`) or UNC
   * (`\\server\...`) target does not qualify: POSIX readers treat it as a
   * relative path with no leading `/`, and it bakes the checkout's drive or
   * host into the link.
   */
  readonly portableAbsolute: boolean;
  /**
   * The on-disk link text. Backslash separators are only converted to `/`
   * on win32, where `\` is the path separator — on POSIX it is a legal
   * filename character and must be left alone.
   */
  readonly rawText: string;
  /**
   * `absolute`, re-expressed as text relative to the link's own directory.
   * Meaningful only when {@link withinRoot} is false and {@link portableAbsolute}
   * is false: it recovers the relative form a POSIX symlink would have used
   * for the same target (this is what pnpm itself writes on Linux), so the
   * hash and archive do not bake in the checkout's absolute location.
   */
  readonly relativeToLink: string;
}

const WINDOWS_ROOTED = /^(?:[A-Za-z]:\/|\/\/)/;

/**
 * Whether an on-disk link target is an absolute path that means the same
 * thing on any platform it is read on — a POSIX-style path with a single
 * leading `/`, as opposed to a Windows drive-letter or UNC path.
 * @param rawText - the on-disk link text, in either separator style
 */
function isPortableAbsolute(rawText: string): boolean {
  const normalized = rawText.split("\\").join("/");
  return normalized.startsWith("/") && !WINDOWS_ROOTED.test(normalized);
}

/**
 * Whether `absolute` resolves inside `root`.
 * @param absolute - absolute path to test
 * @param root - candidate containing directory
 */
function isWithin(absolute: string, root: string): boolean {
  const relative = path.relative(root, absolute);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Resolve a symlink's target against the asset root.
 * Covers both relative targets and the absolute targets Windows junctions
 * always carry (pnpm and npm workspaces link packages with junctions, since
 * those need no special privilege), and normalizes the `\`-separated text
 * Node writes for relative targets on Windows.
 * @param linkPath - absolute path of the symlink
 * @param root - asset root the target is checked against
 */
function resolveLinkTarget(linkPath: string, root: string): LinkTarget {
  const linkText = fs.readlinkSync(linkPath);
  const absolute = path.resolve(path.dirname(linkPath), linkText);

  let containingRoot = root;
  let containedPath = absolute;
  let withinRoot = isWithin(absolute, root);
  if (!withinRoot) {
    // A root reached through a Windows junction or `subst` drive makes an
    // in-root junction's own target look like it escapes: that target is
    // reported against the real directory, never the reparse point, so it
    // no longer shares a textual prefix with the un-resolved root. Retried
    // only now, against real paths, so a tree with no reparse points (the
    // common case) never pays for the extra syscalls and is never affected
    // by a dangling link or a root that no longer exists.
    try {
      const realAbsolute = fs.realpathSync.native(absolute);
      const realRoot = fs.realpathSync.native(root);
      if (isWithin(realAbsolute, realRoot)) {
        containingRoot = realRoot;
        containedPath = realAbsolute;
        withinRoot = true;
      }
    } catch {
      // The target is dangling, or root no longer exists; the first check's
      // answer stands.
    }
  }

  return {
    withinRoot,
    relativeToRoot: withinRoot
      ? path.relative(containingRoot, containedPath).split(path.sep).join("/")
      : "",
    absolute,
    portableAbsolute: isPortableAbsolute(linkText),
    rawText:
      process.platform === "win32" ? linkText.split("\\").join("/") : linkText,
    relativeToLink: path
      .relative(path.dirname(linkPath), absolute)
      .split(path.sep)
      .join("/"),
  };
}

/**
 * Re-express a root-relative canonical link target (see {@link resolveLinkTarget})
 * as text relative to the link's own directory, so it resolves the same way
 * regardless of where the tree containing it is rooted.
 * @param entryRelPath - `/`-separated path of the link itself, relative to the root
 * @param canonicalTarget - the link's target, `/`-separated and relative to the root
 */
function relativeLinkText(
  entryRelPath: string,
  canonicalTarget: string,
): string {
  const slash = entryRelPath.lastIndexOf("/");
  const entryDir = slash === -1 ? "" : entryRelPath.slice(0, slash);
  const text = path.posix.relative(entryDir, canonicalTarget || ".");
  return text === "" ? "." : text;
}

/**
 * Predicate deciding whether a tree entry is skipped.
 * `relPath` is always `/`-separated and relative to the walk root, so patterns
 * behave identically on Windows. `isDirectory` is supplied from the walker's
 * `lstat` so `.gitignore` / `.dockerignore`-style directory-only patterns can
 * be honored without the predicate stat-ing the path itself.
 */
export type ExcludePredicate = (
  relPath: string,
  isDirectory: boolean,
) => boolean;

export interface CopySyncOptions {
  /**
   * Entries for which this returns true are not copied. Called with the
   * entry's `/`-separated relative path and whether it is a directory.
   * Excluding a directory also skips everything below it, unless
   * {@link descendIntoExcludedDirectories} is set.
   *
   * @default - nothing is excluded
   */
  readonly shouldExclude?: ExcludePredicate;

  /**
   * Keep walking into an excluded directory instead of pruning it. The
   * directory entry itself is still omitted; its children are visited and
   * re-tested against {@link shouldExclude}, so a strategy with negation
   * patterns (`node_modules` + `!node_modules/keep`) can re-include entries
   * below an excluded parent. Costs a full walk of excluded subtrees, so it
   * is off unless a strategy asks for it.
   *
   * @default false
   */
  readonly descendIntoExcludedDirectories?: boolean;
}

// Full implementation at https://github.com/jprichardson/node-fs-extra/blob/master/lib/copy/copy-sync.js
/**
 * Copy a file or directory. The directory can have contents and subfolders.
 * Symlinks are recreated as symlinks rather than dereferenced, which keeps the
 * copy consistent with {@link hashPath} (it hashes links by their target) and
 * makes dangling links and link cycles harmless.
 * @param src - source path
 * @param dest - destination path
 * @param options - copy behaviour, see {@link CopySyncOptions}
 */
export function copySync(
  src: string,
  dest: string,
  options: CopySyncOptions = {},
) {
  /**
   * Copies file if present otherwise walks subfolder.
   * @param p - path relative to src/dest
   * @param relPath - `/`-separated path relative to the copy root
   */
  function copyItem(p: string, relPath: string) {
    const sourcePath = path.resolve(src, p);
    const stat = fs.lstatSync(sourcePath);
    const excluded = !!options.shouldExclude?.(relPath, stat.isDirectory());
    // Skip, unless it is an excluded directory being descended into.
    if (
      excluded &&
      !(stat.isDirectory() && options.descendIntoExcludedDirectories)
    ) {
      return;
    }
    if (stat.isSymbolicLink()) {
      copySymlink(sourcePath, relPath, p);
    } else if (stat.isFile()) {
      fs.copyFileSync(sourcePath, path.resolve(dest, p));
    } else if (stat.isDirectory()) {
      walkSubfolder(p, relPath);
    }
  }
  /**
   * Recreate a symlink at the destination.
   * A target inside the asset root is re-expressed relative to the link's
   * own directory, so the copy does not depend on where `src`/`dest` live.
   * A target outside the root cannot be re-expressed that way, so it is
   * recreated verbatim, pointing straight at the real location — this keeps
   * working for a link that is already absolute and self-contained (a
   * pnpm/npm junction, a Lambda-layer-style `/opt` link), and lets a
   * dereferencing bundler still follow a relative escape from a filtered
   * input copy, which could not resolve correctly if re-expressed relative
   * to the scratch directory instead.
   * @param sourcePath - absolute path of the source symlink
   * @param relPath - `/`-separated path of the link, relative to the copy root
   * @param p - path of the link relative to src/dest
   */
  function copySymlink(sourcePath: string, relPath: string, p: string) {
    const link = resolveLinkTarget(sourcePath, src);
    const destPath = path.resolve(dest, p);
    let targetIsDirectory = false;
    try {
      targetIsDirectory = fs.statSync(sourcePath).isDirectory();
    } catch {
      // dangling link: fall through, treated as a file-type link below
    }

    if (!link.withinRoot) {
      createLink(link.absolute, link.absolute, destPath, targetIsDirectory);
      return;
    }
    const linkText = relativeLinkText(relPath, link.relativeToRoot);
    const junctionFallbackTarget = path.resolve(dest, link.relativeToRoot);
    createLink(linkText, junctionFallbackTarget, destPath, targetIsDirectory);
  }

  /**
   * Create a symlink, falling back to a junction if `symlinkSync` hits
   * EPERM on win32 for a directory target — a plain symlink there needs
   * Developer Mode or elevation, but junctions do not. A file target has no
   * such fallback, since junctions only represent directories.
   * @param linkText - text written as the link's target
   * @param junctionFallbackTarget - absolute target used for the win32
   * junction fallback, which needs an absolute path
   * @param destPath - path the link is created at
   * @param targetIsDirectory - whether the target is a directory
   */
  function createLink(
    linkText: string,
    junctionFallbackTarget: string,
    destPath: string,
    targetIsDirectory: boolean,
  ) {
    try {
      fs.symlinkSync(linkText, destPath, targetIsDirectory ? "dir" : "file");
    } catch (err: any) {
      if (process.platform !== "win32" || err.code !== "EPERM") {
        throw err;
      }
      if (targetIsDirectory) {
        fs.symlinkSync(junctionFallbackTarget, destPath, "junction");
      } else {
        throw assetSymlinkNeedsDeveloperMode(destPath, err);
      }
    }
  }
  /**
   * Copies contents of subfolder.
   * @param p - path relative to src/dest
   * @param relPath - `/`-separated path relative to the copy root
   */
  function walkSubfolder(p: string, relPath: string) {
    const sourceDir = path.resolve(src, p);
    fs.mkdirSync(path.resolve(dest, p), { recursive: true });
    fs.readdirSync(sourceDir).forEach((item: string) =>
      copyItem(path.join(p, item), relPath ? `${relPath}/${item}` : item),
    );
  }

  walkSubfolder(".", "");
}

/**
 * Zips contents at src and places zip archive at dest.
 * @param src - directory to archive
 * @param dest - path to write the resulting zip to
 * @param shouldExclude - entries to omit, see {@link CopySyncOptions.shouldExclude}
 * @param descendIntoExcludedDirectories - keep walking excluded directories,
 * see {@link CopySyncOptions.descendIntoExcludedDirectories}
 * @param rejectEscapingSymlinks - reject a symlink whose target resolves
 * outside `src` and is not a portable absolute path, rather than shipping a
 * link that dangles once extracted elsewhere. Gated behind
 * `canonicalAssetHashes`: a portable absolute target (a Lambda-layer-style
 * `/opt` link) ships verbatim either way, since it means the same thing
 * wherever the archive is extracted — but a Windows drive-letter or UNC
 * target (what Windows always reports for a pnpm/npm junction) is rejected
 * just like a relative escape, since on a POSIX extractor it has no leading
 * `/` and resolves as a dangling relative path instead.
 */
export function archiveSync(
  src: string,
  dest: string,
  shouldExclude?: ExcludePredicate,
  descendIntoExcludedDirectories = false,
  rejectEscapingSymlinks = false,
) {
  const files: Record<string, [Uint8Array, ZipOptions]> = {};
  const walk = (dir: string, prefix: string) => {
    // Sorted so entry order — and therefore archive bytes — cannot depend
    // on filesystem enumeration order; matches the canonical hash walk.
    for (const entry of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const zipPath = prefix ? `${prefix}/${entry}` : entry;
      const stat = fs.lstatSync(full);
      const excluded = !!shouldExclude?.(zipPath, stat.isDirectory());
      if (excluded && !(stat.isDirectory() && descendIntoExcludedDirectories)) {
        continue;
      }
      if (stat.isSymbolicLink()) {
        // Store the link target as the entry data with S_IFLNK attrs so
        // extractors recreate the symlink instead of a copy of the target.
        // Never recursing through links also makes cycles unreachable.
        const link = resolveLinkTarget(full, src);
        let targetText: string;
        if (link.withinRoot) {
          // Re-expressed relative to its own entry (see
          // resolveLinkTarget/relativeLinkText) so it resolves the same way
          // after extraction, regardless of where the link originally
          // pointed on disk.
          targetText = relativeLinkText(zipPath, link.relativeToRoot);
        } else if (link.portableAbsolute) {
          targetText = link.rawText;
        } else if (rejectEscapingSymlinks) {
          throw assetSymlinkEscapesRoot(full, link.rawText, src);
        } else {
          targetText = link.rawText;
        }
        files[zipPath] = [
          strToU8(targetText),
          {
            os: ZIP_OS_UNIX,
            attrs: zipAttrs(S_IFLNK | (stat.mode & PERM_MASK)),
            level: 0,
          },
        ];
      } else if (stat.isDirectory()) {
        walk(full, zipPath);
      } else {
        files[zipPath] = [
          fs.readFileSync(full),
          {
            os: ZIP_OS_UNIX,
            attrs: zipAttrs(S_IFREG | (stat.mode & PERM_MASK)),
          },
        ];
      }
    }
  };
  try {
    walk(src, "");
    fs.writeFileSync(
      dest,
      zipSync(files, { level: 9, mtime: ZIP_ENTRY_MTIME }),
    );
  } catch (err: any) {
    throw assetCanNotCreateZipArchive(src, dest, err);
  }
}

export interface HashPathOptions {
  /**
   * Use the canonical entry-framed hash instead of the legacy
   * content-concatenation hash. Enabled through the `canonicalAssetHashes`
   * feature flag.
   */
  readonly canonical?: boolean;
  /**
   * Frame for an archive artifact: archiveSync never emits ZIP directory
   * entries, so canonical hashing omits directory records and the hash
   * tracks the emitted archive bytes exactly. Non-empty directories stay
   * visible through the relative paths of their contents. Has no effect on
   * the legacy scheme, which never records directories.
   */
  readonly archive?: boolean;
  /**
   * Entries for which this returns true are omitted from the digest. Excluding
   * a directory also omits everything below it, unless
   * {@link descendIntoExcludedDirectories} is set. The same predicate must be
   * given to {@link copySync} so the hash and the emitted artifact describe the
   * same set of files.
   *
   * @default - nothing is excluded
   */
  readonly shouldExclude?: ExcludePredicate;

  /**
   * Keep walking into excluded directories, see
   * {@link CopySyncOptions.descendIntoExcludedDirectories}. Must match the
   * value given to {@link copySync} / {@link archiveSync} so the digest covers
   * the same file set the artifact contains.
   *
   * @default false
   */
  readonly descendIntoExcludedDirectories?: boolean;
}

/**
 * Compute a stable MD5 hash of a file or directory's contents.
 * In both schemes symlinks are hashed by their metadata (path + target)
 * instead of being followed, so shared targets are not double-counted and
 * cycles cannot recurse; a symlink at the root itself is followed, matching
 * how the asset source path is opened when the artifact is emitted.
 * @param src - path to a file or directory to hash
 * @param options - hash scheme selection, see {@link HashPathOptions}
 * @returns uppercased hex digest, truncated to HASH_LEN characters
 */
export function hashPath(src: string, options: HashPathOptions = {}): string {
  const digest = options.canonical
    ? canonicalHashPath(
        src,
        !options.archive,
        options.shouldExclude,
        options.descendIntoExcludedDirectories,
      )
    : legacyHashPath(
        src,
        options.shouldExclude,
        options.descendIntoExcludedDirectories,
      );
  return digest.slice(0, HASH_LEN).toUpperCase();
}

/**
 * Legacy-compatible hash: file contents fold into one digest in
 * directory-listing order, exactly as earlier releases did, so trees without
 * symlinks keep their historical hashes. Symlink metadata goes into a second
 * digest, and only when symlinks exist are the two combined under a tagged
 * outer hash — the tag keeps symlink metadata in a separate domain from file
 * bytes, so a file containing `foo` can never collide with a symlink
 * targeting `foo`.
 * @param src - path to a file or directory to hash
 * @param shouldExclude - entries to omit, see {@link HashPathOptions.shouldExclude}
 * @param descendIntoExcludedDirectories - keep walking excluded directories,
 * see {@link HashPathOptions.descendIntoExcludedDirectories}
 */
function legacyHashPath(
  src: string,
  shouldExclude?: ExcludePredicate,
  descendIntoExcludedDirectories = false,
): string {
  const content = crypto.createHash("md5");
  const links = crypto.createHash("md5");
  let linkCount = 0;

  /**
   * Walk `p`, feeding file contents and symlink metadata into the enclosing
   * accumulators.
   * @param p - path to walk
   * @param relPath - path of `p` relative to the walk root, `/`-separated
   * @param isRoot - follow a symlink only at the root, matching how the
   * asset's own path is resolved when it is read
   */
  function hashRecursion(p: string, relPath: string, isRoot = false) {
    const stat = isRoot ? fs.statSync(p) : fs.lstatSync(p);
    if (stat.isSymbolicLink()) {
      links.update(`${relPath}\0${fs.readlinkSync(p)}\0`);
      linkCount++;
    } else if (stat.isFile()) {
      content.update(fs.readFileSync(p));
    } else if (stat.isDirectory()) {
      fs.readdirSync(p).forEach((filename) => {
        const entryRelPath = relPath ? `${relPath}/${filename}` : filename;
        const childPath = path.resolve(p, filename);
        const childIsDir = fs.lstatSync(childPath).isDirectory();
        if (shouldExclude?.(entryRelPath, childIsDir)) {
          // Skip, unless it is an excluded directory being descended into.
          if (!(childIsDir && descendIntoExcludedDirectories)) {
            return;
          }
        }
        hashRecursion(childPath, entryRelPath);
      });
    }
  }

  hashRecursion(src, "", true);
  if (linkCount === 0) {
    return content.digest("hex");
  }
  const outer = crypto.createHash("md5");
  outer.update("cdktn/asset-hash/symlinks/v1\0");
  outer.update(content.digest("hex"));
  outer.update(links.digest("hex"));
  return outer.digest("hex");
}

/**
 * Canonical hash, modeled on git trees and Nix NAR: every entry is framed
 * with everything that affects the emitted artifact —
 *
 * - files:      `F <mode> <relPath>\0<size>\0` + content, where `<mode>` is
 *               the octal permission mask (`0o7777` bits) that archiveSync
 *               preserves in zip external attributes,
 * - symlinks:   `L <mode> <relPath>\0<target byte length>\0` + target, where
 *               `<target>` is, for a target inside the asset root, the
 *               target resolved to a `/`-separated path relative to the
 *               root (see {@link resolveLinkTarget}) — so the hash does not
 *               depend on checkout location, and is not sensitive to
 *               `\`-separated Windows link text within one operating
 *               system. For a target outside the root that is itself a
 *               portable absolute path (a POSIX path such as `/opt/...`),
 *               `<target>` is the raw on-disk link text, since that already
 *               means the same thing anywhere. For any other target outside
 *               the root — including a Windows drive-letter or UNC path,
 *               which Windows always reports as absolute even for an in-root
 *               junction — `<target>` is instead the target re-expressed
 *               relative to the link's own directory, recovering the form a
 *               POSIX symlink would have used and keeping the checkout's
 *               absolute location out of the hash,
 * - directories (including empty ones, which copySync materializes):
 *               `D <relPath>\0`, with no mode — neither archiveSync nor
 *               copySync preserves directory permissions,
 *
 * in sorted directory order with `/`-separated relative paths, so renames,
 * entry-boundary shifts, permission changes, empty-directory changes, and
 * file-vs-symlink swaps all change the digest.
 * @param src - path to a file or directory to hash
 * @param includeDirectories - record directory entries; false for archive
 * artifacts, where the emitted zip has no directory entries
 * @param shouldExclude - entries to omit, see {@link HashPathOptions.shouldExclude}
 */
function canonicalHashPath(
  src: string,
  includeDirectories: boolean,
  shouldExclude?: ExcludePredicate,
  descendIntoExcludedDirectories = false,
): string {
  const hash = crypto.createHash("md5");

  /**
   * Walk `p`, framing each entry into the enclosing hash accumulator.
   * @param p - path to walk
   * @param relPath - path of `p` relative to the walk root, `/`-separated
   * @param isRoot - follow a symlink only at the root, matching how the
   * asset's own path is resolved when the artifact is emitted
   */
  function hashRecursion(p: string, relPath: string, isRoot = false) {
    const stat = isRoot ? fs.statSync(p) : fs.lstatSync(p);
    const mode = (stat.mode & PERM_MASK).toString(8);
    if (stat.isSymbolicLink()) {
      const link = resolveLinkTarget(p, src);
      const target = link.withinRoot
        ? link.relativeToRoot
        : link.portableAbsolute
          ? link.rawText
          : link.relativeToLink;
      hash.update(`L ${mode} ${relPath}\0${Buffer.byteLength(target)}\0`);
      hash.update(target);
    } else if (stat.isFile()) {
      const data = fs.readFileSync(p);
      hash.update(`F ${mode} ${relPath}\0${data.length}\0`);
      hash.update(data);
    } else if (stat.isDirectory()) {
      // Records the `D` entry even for a descended-into excluded directory,
      // matching the empty directory copySync leaves on disk.
      if (relPath && includeDirectories) {
        hash.update(`D ${relPath}\0`);
      }
      for (const filename of fs.readdirSync(p).sort()) {
        const entryRelPath = relPath ? `${relPath}/${filename}` : filename;
        const childPath = path.resolve(p, filename);
        const childIsDir = fs.lstatSync(childPath).isDirectory();
        if (shouldExclude?.(entryRelPath, childIsDir)) {
          // Skip, unless it is an excluded directory being descended into.
          if (!(childIsDir && descendIntoExcludedDirectories)) {
            continue;
          }
        }
        hashRecursion(childPath, entryRelPath);
      }
    }
  }

  hashRecursion(src, "", true);
  return hash.digest("hex");
}

/**
 * Build a predicate matching the exclusion forms accepted by
 * `AssetHashOptions.exclude` (via `ExcludeIgnoreStrategy`): an exact relative
 * path, a `*.ext` suffix, or a directory (with or without a trailing `/`),
 * which also excludes its contents.
 * Deliberately not a full glob implementation — `**`, `?`, character classes and
 * `!` negation are not supported, and a pattern is never interpreted as
 * anchoring to a subdirectory it does not name.
 * The returned matcher looks only at the path, not at whether the entry is a
 * directory: `dir` and `dir/` both match a directory named `dir` and its
 * contents. It is therefore narrower than {@link ExcludePredicate}, which also
 * receives an `isDirectory` flag for strategies that need it.
 * @param exclude - patterns to exclude
 * @returns predicate over `/`-separated paths relative to the asset root
 */
export function excludeMatcher(
  exclude: string[],
): (relativePath: string) => boolean {
  // `/`-separated throughout: relative paths are normalized before matching, so
  // `dir/child` patterns work the same on Windows.
  const patterns = exclude.map((p) => p.replace(/\\/g, "/"));
  return (relativePath: string) => {
    for (const pattern of patterns) {
      if (pattern.startsWith("*.") && relativePath.endsWith(pattern.slice(1))) {
        return true;
      }
      const dir = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
      if (relativePath === dir || relativePath.startsWith(`${dir}/`)) {
        return true;
      }
    }
    return false;
  };
}

/**
 * Walk upward from `rootPath` looking for a file with the given name.
 * Returns the absolute path of the first match, or `null` if the search
 * reaches the filesystem root without finding it.
 * @param file - filename to search for
 * @param rootPath - directory to start the search from (defaults to cwd)
 * @returns absolute path to the file, or null if not found
 */
export function findFileAboveCwd(
  file: string,
  rootPath: string = process.cwd(),
): string | null {
  const fullPath = path.resolve(rootPath, file);
  if (fs.existsSync(fullPath)) {
    return fullPath;
  }

  const parentDir = path.resolve(rootPath, "..");
  if (fs.existsSync(parentDir) && parentDir !== rootPath) {
    return findFileAboveCwd(file, parentDir);
  }

  return null;
}

const RETRY_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 50;
const RENAME_RETRY_CODES = ["EPERM", "EACCES", "EBUSY"];

/**
 * Rename `src` to `dest`, retrying with a short backoff while Windows refuses
 * because a file inside is briefly open (antivirus, search indexer).
 * @param src - path to rename
 * @param dest - new path
 */
export function renameSyncWithRetry(src: string, dest: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err: any) {
      if (attempt >= RETRY_ATTEMPTS || !RENAME_RETRY_CODES.includes(err.code)) {
        throw err;
      }
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        RETRY_BACKOFF_MS * 2 ** (attempt - 1),
      );
    }
  }
}

/**
 * Remove `target` recursively, letting Node retry while Windows briefly holds
 * a file inside open.
 * @param target - path to remove
 */
export function rmSyncWithRetry(target: string): void {
  fs.rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: RETRY_ATTEMPTS - 1,
    retryDelay: RETRY_BACKOFF_MS,
  });
}

/**
 * Repoint a win32 junction fallback (see `copySync`'s `createLink`) that was
 * created under `oldRoot` and then moved, folder and all, to `newRoot`.
 *
 * A junction stores an absolute target. `copySync` points that target at the
 * copy it is building (`oldRoot`) so the result is self-contained, but a
 * caller that stages into a sibling folder and renames it into place (so a
 * failed build never leaves a reusable folder) moves the junction without
 * moving the text inside it. This walks `newRoot` and rewrites any junction
 * whose target still points under `oldRoot` to the same relative location
 * under `newRoot` instead.
 * @param newRoot - the folder's path after the move
 * @param oldRoot - the folder's path before the move, as baked into any
 * junction `copySync` created inside it
 */
export function reanchorJunctions(newRoot: string, oldRoot: string): void {
  if (process.platform !== "win32" || newRoot === oldRoot) {
    return;
  }
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        if (path.isAbsolute(target) && isWithin(target, oldRoot)) {
          const relativeToOldRoot = path.relative(oldRoot, target);
          fs.unlinkSync(full);
          fs.symlinkSync(
            path.join(newRoot, relativeToOldRoot),
            full,
            "junction",
          );
        }
      } else if (stat.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(newRoot);
}
