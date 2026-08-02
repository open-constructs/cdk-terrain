// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
// Repros for https://github.com/open-constructs/cdk-terrain/issues/320
// AssetType.ARCHIVE follows symlinks: content is duplicated per link path,
// no symlink entries are preserved, and circular links crash synth (ELOOP).
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { archiveSync, copySync, hashPath } from "../src/private/fs";
import {
  testIfPosixPermissions,
  testIfSymlinks,
  testIfSymlinksAndUnzip,
} from "./helper/capabilities";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-symlink-test-"));
}

/**
 * Extracts a zip with the system `unzip`, which restores entries carrying
 * unix S_IFLNK mode bits as real symlinks on disk.
 */
function extractZip(zipPath: string): string {
  const extractDir = createTempDir();
  execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: "ignore" });
  return extractDir;
}

describe("archiveSync symlink handling (#320)", () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    srcDir = createTempDir();
    destDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  testIfSymlinksAndUnzip("preserves a file symlink as a symlink entry", () => {
    fs.writeFileSync(path.join(srcDir, "file.txt"), "content");
    fs.symlinkSync("file.txt", path.join(srcDir, "alias.txt"));

    const zipPath = path.join(destDir, "output.zip");
    archiveSync(srcDir, zipPath);

    const extracted = extractZip(zipPath);
    const alias = path.join(extracted, "alias.txt");
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(alias)).toBe("file.txt");
    expect(fs.readFileSync(alias, "utf-8")).toBe("content");
  });

  testIfSymlinksAndUnzip(
    "preserves directory symlinks instead of recursing into the target",
    () => {
      // pnpm-style layout: two links share one real package
      fs.mkdirSync(path.join(srcDir, "real-pkg"));
      fs.writeFileSync(path.join(srcDir, "real-pkg", "index.js"), "module");
      fs.symlinkSync("real-pkg", path.join(srcDir, "link-a"));
      fs.symlinkSync("real-pkg", path.join(srcDir, "link-b"));

      const zipPath = path.join(destDir, "output.zip");
      archiveSync(srcDir, zipPath);

      const extracted = extractZip(zipPath);
      expect(
        fs.lstatSync(path.join(extracted, "link-a")).isSymbolicLink(),
      ).toBe(true);
      expect(fs.readlinkSync(path.join(extracted, "link-a"))).toBe("real-pkg");
      // the target's content must exist exactly once, under its real path
      expect(
        fs.readFileSync(path.join(extracted, "real-pkg", "index.js"), "utf-8"),
      ).toBe("module");
      // and NOT as a materialized copy beneath the link paths
      expect(fs.lstatSync(path.join(extracted, "link-a")).isDirectory()).toBe(
        false,
      );
    },
  );

  testIfSymlinks(
    "does not duplicate shared symlink targets into the archive",
    () => {
      // incompressible payload so duplication shows up in the zip size
      const payload = crypto.randomBytes(200 * 1024);
      fs.mkdirSync(path.join(srcDir, "real-pkg"));
      fs.writeFileSync(path.join(srcDir, "real-pkg", "blob.bin"), payload);
      fs.symlinkSync("real-pkg", path.join(srcDir, "link-a"));
      fs.symlinkSync("real-pkg", path.join(srcDir, "link-b"));

      const zipPath = path.join(destDir, "output.zip");
      archiveSync(srcDir, zipPath);

      // one stored copy ≈ 200 KiB; the buggy walk stores three (~600 KiB)
      expect(fs.statSync(zipPath).size).toBeLessThan(250 * 1024);
    },
  );

  testIfSymlinksAndUnzip("does not crash on circular symlinks (ELOOP)", () => {
    // pnpm trees legitimately contain self-referential links
    fs.mkdirSync(path.join(srcDir, "pkg"));
    fs.writeFileSync(path.join(srcDir, "pkg", "index.js"), "module");
    fs.symlinkSync("../pkg", path.join(srcDir, "pkg", "self"));

    const zipPath = path.join(destDir, "output.zip");
    expect(() => archiveSync(srcDir, zipPath)).not.toThrow();

    const extracted = extractZip(zipPath);
    expect(
      fs.lstatSync(path.join(extracted, "pkg", "self")).isSymbolicLink(),
    ).toBe(true);
  });
});

describe("hashPath symlink handling (#320)", () => {
  let srcDir: string;

  beforeEach(() => {
    srcDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  testIfSymlinks("does not crash on circular symlinks (ELOOP)", () => {
    // hashPath runs in the TerraformAsset constructor for EVERY asset type,
    // so this crash hits before archiving even starts
    fs.mkdirSync(path.join(srcDir, "pkg"));
    fs.writeFileSync(path.join(srcDir, "pkg", "index.js"), "module");
    fs.symlinkSync("../pkg", path.join(srcDir, "pkg", "self"));

    expect(() => hashPath(srcDir)).not.toThrow();
  });

  testIfSymlinks("hash changes when a symlink is retargeted", () => {
    fs.writeFileSync(path.join(srcDir, "a.txt"), "aaa");
    fs.writeFileSync(path.join(srcDir, "b.txt"), "bbb");
    fs.symlinkSync("a.txt", path.join(srcDir, "current"));
    const before = hashPath(srcDir);

    fs.rmSync(path.join(srcDir, "current"));
    fs.symlinkSync("b.txt", path.join(srcDir, "current"));
    const after = hashPath(srcDir);

    expect(before).not.toBe(after);
  });

  testIfSymlinks(
    "a regular file and a symlink with the same payload hash differently",
    () => {
      // both trees contain a `current` entry whose payload bytes are `a.txt`
      const asFile = createTempDir();
      fs.writeFileSync(path.join(asFile, "current"), "a.txt");
      const asLink = createTempDir();
      fs.symlinkSync("a.txt", path.join(asLink, "current"));

      expect(hashPath(asFile)).not.toBe(hashPath(asLink));

      fs.rmSync(asFile, { recursive: true, force: true });
      fs.rmSync(asLink, { recursive: true, force: true });
    },
  );

  test("trees without symlinks keep their legacy hash byte-for-byte", () => {
    fs.mkdirSync(path.join(srcDir, "sub"));
    fs.writeFileSync(path.join(srcDir, "a.txt"), "aaa");
    fs.writeFileSync(path.join(srcDir, "sub", "b.txt"), "bbb");

    // the historical scheme: file contents folded into one md5 in
    // directory-listing order, uppercased
    const legacy = crypto.createHash("md5");
    legacy.update("aaa");
    legacy.update("bbb");

    expect(hashPath(srcDir)).toBe(legacy.digest("hex").toUpperCase());
  });
});

describe("copySync symlink handling (#320)", () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    srcDir = createTempDir();
    destDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  testIfSymlinks("recreates symlinks instead of copying their targets", () => {
    fs.mkdirSync(path.join(srcDir, "real-pkg"));
    fs.writeFileSync(path.join(srcDir, "real-pkg", "index.js"), "module");
    fs.symlinkSync("real-pkg", path.join(srcDir, "link-a"));

    copySync(srcDir, destDir);

    const link = path.join(destDir, "link-a");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe("real-pkg");
    expect(fs.readFileSync(path.join(link, "index.js"), "utf-8")).toBe(
      "module",
    );
  });

  testIfSymlinks("does not crash on circular symlinks (ELOOP)", () => {
    fs.mkdirSync(path.join(srcDir, "pkg"));
    fs.writeFileSync(path.join(srcDir, "pkg", "index.js"), "module");
    fs.symlinkSync("../pkg", path.join(srcDir, "pkg", "self"));

    expect(() => copySync(srcDir, destDir)).not.toThrow();
    expect(
      fs.lstatSync(path.join(destDir, "pkg", "self")).isSymbolicLink(),
    ).toBe(true);
  });
});

describe("archiveSync zip metadata (#320 follow-ups)", () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    srcDir = createTempDir();
    destDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  testIfPosixPermissions(
    "preserves the executable bit on regular files",
    () => {
      const script = path.join(srcDir, "run.sh");
      fs.writeFileSync(script, "#!/bin/sh\necho hi\n");
      fs.chmodSync(script, 0o755);

      const zipPath = path.join(destDir, "output.zip");
      archiveSync(srcDir, zipPath);

      const extracted = extractZip(zipPath);
      const mode = fs.statSync(path.join(extracted, "run.sh")).mode;
      expect(mode & 0o111).not.toBe(0);
    },
  );

  testIfSymlinks("produces byte-identical archives across runs", async () => {
    fs.mkdirSync(path.join(srcDir, "sub"));
    fs.writeFileSync(path.join(srcDir, "a.txt"), "aaa");
    fs.writeFileSync(path.join(srcDir, "sub", "b.txt"), "bbb");
    fs.symlinkSync("a.txt", path.join(srcDir, "link"));

    const first = path.join(destDir, "first.zip");
    const second = path.join(destDir, "second.zip");
    archiveSync(srcDir, first);
    // entry mtimes are pinned, so wall-clock time must not leak into bytes
    await new Promise((resolve) => setTimeout(resolve, 1100));
    archiveSync(srcDir, second);

    expect(fs.readFileSync(first).equals(fs.readFileSync(second))).toBe(true);
  });
});
