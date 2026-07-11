// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { strToU8, zipSync } from "fflate";
import type { ZipOptions } from "fflate";
import { assetCanNotCreateZipArchive } from "../errors";

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

// Full implementation at https://github.com/jprichardson/node-fs-extra/blob/master/lib/copy/copy-sync.js
/**
 * Copy a file or directory. The directory can have contents and subfolders.
 * @param src - source path
 * @param dest - destination path
 */
export function copySync(src: string, dest: string) {
  /**
   * Copies file if present otherwise walks subfolder.
   * @param p - path relative to src/dest
   */
  function copyItem(p: string) {
    const sourcePath = path.resolve(src, p);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(sourcePath), path.resolve(dest, p));
    } else if (stat.isFile()) {
      fs.copyFileSync(sourcePath, path.resolve(dest, p));
    } else if (stat.isDirectory()) {
      walkSubfolder(p);
    }
  }
  /**
   * Copies contents of subfolder.
   * @param p - path relative to src/dest
   */
  function walkSubfolder(p: string) {
    const sourceDir = path.resolve(src, p);
    fs.mkdirSync(path.resolve(dest, p), { recursive: true });
    fs.readdirSync(sourceDir).forEach((item: string) =>
      copyItem(path.join(p, item)),
    );
  }

  walkSubfolder(".");
}

/**
 * Zips contents at src and places zip archive at dest.
 * @param src - directory to archive
 * @param dest - path to write the resulting zip to
 */
export function archiveSync(src: string, dest: string) {
  try {
    const files: Record<string, [Uint8Array, ZipOptions]> = {};
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        const zipPath = prefix ? `${prefix}/${entry}` : entry;
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) {
          // Store the link target as the entry data with S_IFLNK attrs so
          // extractors recreate the symlink instead of a copy of the target.
          // Never recursing through links also makes cycles unreachable.
          files[zipPath] = [
            strToU8(fs.readlinkSync(full)),
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
    ? canonicalHashPath(src)
    : legacyHashPath(src);
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
 */
function legacyHashPath(src: string): string {
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
      fs.readdirSync(p).forEach((filename) =>
        hashRecursion(
          path.resolve(p, filename),
          relPath ? `${relPath}/${filename}` : filename,
        ),
      );
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
 * - symlinks:   `L <mode> <relPath>\0<target byte length>\0` + target,
 * - directories (including empty ones, which copySync materializes):
 *               `D <relPath>\0`, with no mode — neither archiveSync nor
 *               copySync preserves directory permissions,
 *
 * in sorted directory order with `/`-separated relative paths, so renames,
 * entry-boundary shifts, permission changes, empty-directory changes, and
 * file-vs-symlink swaps all change the digest.
 * @param src - path to a file or directory to hash
 */
function canonicalHashPath(src: string): string {
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
      const target = fs.readlinkSync(p);
      hash.update(`L ${mode} ${relPath}\0${Buffer.byteLength(target)}\0`);
      hash.update(target);
    } else if (stat.isFile()) {
      const data = fs.readFileSync(p);
      hash.update(`F ${mode} ${relPath}\0${data.length}\0`);
      hash.update(data);
    } else if (stat.isDirectory()) {
      if (relPath) {
        hash.update(`D ${relPath}\0`);
      }
      for (const filename of fs.readdirSync(p).sort()) {
        hashRecursion(
          path.resolve(p, filename),
          relPath ? `${relPath}/${filename}` : filename,
        );
      }
    }
  }

  hashRecursion(src, "", true);
  return hash.digest("hex");
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
