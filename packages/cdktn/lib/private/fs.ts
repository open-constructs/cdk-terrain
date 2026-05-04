// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { assetCanNotCreateZipArchive } from "../errors";
import { execSync } from "child_process";

const HASH_LEN = 32;

// Full implementation at https://github.com/jprichardson/node-fs-extra/blob/master/lib/copy/copy-sync.js
/**
 * Copy a file or directory. The directory can have contents and subfolders.
 * @param {string} src
 * @param {string} dest
 */
export function copySync(src: string, dest: string) {
  /**
   * Copies file if present otherwise walks subfolder
   * @param {string} p
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
   * Copies contents of subfolder
   * @param {string} p
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
 * Zips contents at src and places zip archive at dest
 * @param {string} src
 * @param {string} dest
 */
export function archiveSync(src: string, dest: string) {
  // Run this module as a CLI to get around the synchronous limitation
  try {
    execSync(`node ${__filename} ${src} ${dest}`, { encoding: "utf-8" });
  } catch (err: any) {
    throw assetCanNotCreateZipArchive(src, dest, err);
  }
}

/**
 * Recursively adds all files under dir to the zip, preserving
 * relative paths
 * @param zip - the instance to add entries to
 * @param dir - absolute path of the directory to walk
 * @param prefix - the path prefix for entries within the zip (empty string for root)
 */
function addDirectory(zip: any, dir: string, prefix: string) {
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const zipPath = prefix ? `${prefix}/${entry}` : entry;
    if (fs.statSync(fullPath).isDirectory()) {
      addDirectory(zip, fullPath, zipPath);
    } else {
      zip.addFile(fullPath, zipPath, { compress: true, compressionLevel: 9 });
    }
  }
}

/**
 *
 * @param src
 * @param dest
 */
async function runArchive(src: string, dest: string) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ZipFile } = require("yazl");
  const zip = new ZipFile();

  addDirectory(zip, src, "");
  zip.end();

  return new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(dest);
    zip.outputStream.pipe(output);
    output.on("close", resolve);
    output.on("error", reject);
    zip.outputStream.on("error", reject);
  });
}

// If this file is executed as a CLI we run archive directly
// It's a bit of a hack due to us being restricted to synchronous functions
// when there is no sync way to create a zip archive.
// We get around this by using execSync and invoking this file as the CLI.
// This only works for one function, but we only have this use-case once.
if (require.main === module) {
  const src = process.argv[2];
  const dest = process.argv[3];
  runArchive(src, dest)
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

// eslint-disable-next-line jsdoc/require-jsdoc
export function hashPath(src: string) {
  const hash = crypto.createHash("md5");

  // eslint-disable-next-line jsdoc/require-jsdoc
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

// eslint-disable-next-line jsdoc/require-jsdoc
export function findFileAboveCwd(
  file: string,
  rootPath = process.cwd(),
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

/**
 * Walk up the directory tree from `startDir`. At each level, prefer
 * cdktn.json over cdktf.json. Returns the absolute path to the first
 * config file found, or null if none exists in any parent directory.
 * @param startDir - directory to start the search from
 */
export function findConfigAbove(startDir = process.cwd()): string | null {
  const dir = path.resolve(startDir);

  const primary = path.join(dir, "cdktn.json");
  if (fs.existsSync(primary)) {
    return primary;
  }

  const legacy = path.join(dir, "cdktf.json");
  if (fs.existsSync(legacy)) {
    return legacy;
  }

  const parent = path.resolve(dir, "..");
  if (parent === dir) {
    return null;
  }

  return findConfigAbove(parent);
}
