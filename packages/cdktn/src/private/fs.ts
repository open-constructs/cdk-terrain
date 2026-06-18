// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { zipSync } from "fflate";
import { assetCanNotCreateZipArchive } from "../errors";

const HASH_LEN = 32;

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
    const stat = fs.statSync(sourcePath);
    if (stat.isFile()) {
      fs.copyFileSync(sourcePath, path.resolve(dest, p));
    }
    if (stat.isDirectory()) {
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
    const files: Record<string, Uint8Array> = {};
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        const zipPath = prefix ? `${prefix}/${entry}` : entry;
        if (fs.statSync(full).isDirectory()) {
          walk(full, zipPath);
        } else {
          files[zipPath] = fs.readFileSync(full);
        }
      }
    };
    walk(src, "");
    fs.writeFileSync(dest, zipSync(files, { level: 9 }));
  } catch (err: any) {
    throw assetCanNotCreateZipArchive(src, dest, err);
  }
}

/**
 * Compute a stable MD5 hash of a file or directory's contents.
 * Directories are hashed by recursively folding each file's contents into
 * the same digest, in directory-listing order.
 * @param src - path to a file or directory to hash
 * @returns uppercased hex digest, truncated to HASH_LEN characters
 */
export function hashPath(src: string): string {
  const hash = crypto.createHash("md5");

  /**
   * Walk `p`, feeding any file contents into the enclosing hash accumulator.
   * @param p - path to walk
   */
  function hashRecursion(p: string) {
    const stat = fs.statSync(p);
    if (stat.isFile()) {
      hash.update(fs.readFileSync(p));
    } else if (stat.isDirectory()) {
      fs.readdirSync(p).forEach((filename) =>
        hashRecursion(path.resolve(p, filename)),
      );
    }
  }

  hashRecursion(src);
  return hash.digest("hex").slice(0, HASH_LEN).toUpperCase();
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
