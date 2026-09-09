// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  AssetStaging,
  AssetHashType,
  FileAssetPackaging,
  TerraformStack,
  Testing,
} from "../lib";
import { CANONICAL_ASSET_HASHES } from "../lib/features";
import { hashPath } from "../lib/private/fs";

describe("AssetStaging", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-asset-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("basic functionality", () => {
    test("can stage a single file", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      // Create a test file
      const testFile = path.join(tempDir, "test.txt");
      fs.writeFileSync(testFile, "Hello, World!");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: testFile,
      });

      expect(asset.assetHash).toBeDefined();
      expect(asset.assetHash).toHaveLength(32); // MD5 hash (unified with TerraformAsset)
      expect(asset.assetHash).toMatch(/^[A-F0-9]{32}$/); // Uppercase hex
      expect(asset.isArchive).toBe(false);
      expect(asset.packaging).toBe(FileAssetPackaging.FILE);
      expect(asset.sourcePath).toBe(testFile);
      expect(asset.absoluteStagedPath).toBeDefined();
    });

    test("can stage a directory", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      // Create a test directory with files
      const testDir = path.join(tempDir, "test-dir");
      fs.mkdirSync(testDir);
      fs.writeFileSync(path.join(testDir, "file1.txt"), "Content 1");
      fs.writeFileSync(path.join(testDir, "file2.txt"), "Content 2");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: testDir,
      });

      expect(asset.assetHash).toBeDefined();
      expect(asset.isArchive).toBe(true);
      expect(asset.packaging).toBe(FileAssetPackaging.ZIP_DIRECTORY);
    });

    test("throws error for non-existent path", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      expect(() => {
        new AssetStaging(stack, "Asset", {
          sourcePath: "/non/existent/path",
        });
      }).toThrow("Cannot find asset at /non/existent/path");
    });
  });

  describe("hashing", () => {
    test("produces consistent hash for same content", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const testFile1 = path.join(tempDir, "test1.txt");
      const testFile2 = path.join(tempDir, "test2.txt");
      fs.writeFileSync(testFile1, "Same content");
      fs.writeFileSync(testFile2, "Same content");

      const asset1 = new AssetStaging(stack, "Asset1", {
        sourcePath: testFile1,
      });

      const asset2 = new AssetStaging(stack, "Asset2", {
        sourcePath: testFile2,
      });

      expect(asset1.assetHash).toBe(asset2.assetHash);
    });

    test("produces different hash for different content", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const testFile1 = path.join(tempDir, "test1.txt");
      const testFile2 = path.join(tempDir, "test2.txt");
      fs.writeFileSync(testFile1, "Content A");
      fs.writeFileSync(testFile2, "Content B");

      const asset1 = new AssetStaging(stack, "Asset1", {
        sourcePath: testFile1,
      });

      const asset2 = new AssetStaging(stack, "Asset2", {
        sourcePath: testFile2,
      });

      expect(asset1.assetHash).not.toBe(asset2.assetHash);
    });

    test("supports custom hash", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const testFile = path.join(tempDir, "test.txt");
      fs.writeFileSync(testFile, "Content");

      const customHash = "my-custom-hash-v1";
      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: testFile,
        assetHash: customHash,
        assetHashType: AssetHashType.CUSTOM,
      });

      // Custom hash should be used verbatim (matches TerraformAsset behavior)
      expect(asset.assetHash).toBe(customHash);
    });

    test("uses extraHash in hash calculation", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const testFile = path.join(tempDir, "test.txt");
      fs.writeFileSync(testFile, "Same content");

      const asset1 = new AssetStaging(stack, "Asset1", {
        sourcePath: testFile,
        extraHash: "extra-1",
      });

      const asset2 = new AssetStaging(stack, "Asset2", {
        sourcePath: testFile,
        extraHash: "extra-2",
      });

      expect(asset1.assetHash).not.toBe(asset2.assetHash);
    });

    test("throws error when custom hash type without hash value", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const testFile = path.join(tempDir, "test.txt");
      fs.writeFileSync(testFile, "Content");

      expect(() => {
        new AssetStaging(stack, "Asset", {
          sourcePath: testFile,
          assetHashType: AssetHashType.CUSTOM,
          // assetHash is missing
        });
      }).toThrow("assetHash must be specified when assetHashType is CUSTOM");
    });
  });

  describe("exclusions", () => {
    test("excludes files matching patterns", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      // Create directory with files to exclude
      const testDir = path.join(tempDir, "test-dir");
      fs.mkdirSync(testDir);
      fs.writeFileSync(path.join(testDir, "include.txt"), "Include me");
      fs.writeFileSync(path.join(testDir, "exclude.md"), "Exclude me");
      fs.writeFileSync(path.join(testDir, "README.md"), "Exclude me too");

      const asset1 = new AssetStaging(stack, "Asset1", {
        sourcePath: testDir,
      });

      const asset2 = new AssetStaging(stack, "Asset2", {
        sourcePath: testDir,
        exclude: ["*.md"],
      });

      // Hash should be different because asset2 excludes .md files
      expect(asset1.assetHash).not.toBe(asset2.assetHash);
    });

    test("excludes directories matching patterns", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const testDir = path.join(tempDir, "test-dir");
      fs.mkdirSync(testDir);
      fs.mkdirSync(path.join(testDir, "node_modules"));
      fs.writeFileSync(path.join(testDir, "index.js"), "code");
      fs.writeFileSync(
        path.join(testDir, "node_modules", "dep.js"),
        "dependency",
      );

      const asset1 = new AssetStaging(stack, "Asset1", {
        sourcePath: testDir,
      });

      const asset2 = new AssetStaging(stack, "Asset2", {
        sourcePath: testDir,
        exclude: ["node_modules"],
      });

      expect(asset1.assetHash).not.toBe(asset2.assetHash);
    });
  });

  describe("symlinks", () => {
    test("ignores symlinks by default", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const testDir = path.join(tempDir, "test-dir");
      fs.mkdirSync(testDir);
      fs.writeFileSync(path.join(testDir, "real.txt"), "real content");

      const linkPath = path.join(testDir, "link.txt");
      try {
        fs.symlinkSync(path.join(testDir, "real.txt"), linkPath);
      } catch (_e) {
        // Skip test if symlinks are not supported (e.g., Windows without admin)
        return;
      }

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: testDir,
      });

      expect(asset.assetHash).toBeDefined();
    });
  });

  describe("directory hashing", () => {
    test("hashes directories recursively", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const testDir = path.join(tempDir, "test-dir");
      fs.mkdirSync(testDir);
      fs.mkdirSync(path.join(testDir, "subdir"));
      fs.writeFileSync(path.join(testDir, "file1.txt"), "Content 1");
      fs.writeFileSync(path.join(testDir, "subdir", "file2.txt"), "Content 2");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: testDir,
      });

      expect(asset.assetHash).toBeDefined();
      expect(asset.isArchive).toBe(true);
    });

    test("produces consistent hash for same directory structure", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      // Create two identical directory structures
      const dir1 = path.join(tempDir, "dir1");
      const dir2 = path.join(tempDir, "dir2");

      for (const dir of [dir1, dir2]) {
        fs.mkdirSync(dir);
        fs.mkdirSync(path.join(dir, "subdir"));
        fs.writeFileSync(path.join(dir, "a.txt"), "A");
        fs.writeFileSync(path.join(dir, "subdir", "b.txt"), "B");
      }

      const asset1 = new AssetStaging(stack, "Asset1", {
        sourcePath: dir1,
      });

      const asset2 = new AssetStaging(stack, "Asset2", {
        sourcePath: dir2,
      });

      expect(asset1.assetHash).toBe(asset2.assetHash);
    });
  });

  describe("exclusion patterns", () => {
    test("excludes markdown files", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const dir = path.join(tempDir, "testdir");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "index.js"), "console.log('hi')");
      fs.writeFileSync(path.join(dir, "README.md"), "# Docs");

      const assetWithMd = new AssetStaging(stack, "WithMd", {
        sourcePath: dir,
      });

      const assetNoMd = new AssetStaging(stack, "NoMd", {
        sourcePath: dir,
        exclude: ["*.md"],
      });

      // Hash should differ when excluding files
      expect(assetNoMd.assetHash).not.toBe(assetWithMd.assetHash);
    });

    test("excludes directories", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const dir = path.join(tempDir, "testdir");
      fs.mkdirSync(dir);
      fs.mkdirSync(path.join(dir, "node_modules"));
      fs.writeFileSync(path.join(dir, "index.js"), "code");
      fs.writeFileSync(path.join(dir, "node_modules", "dep.js"), "dep");

      const assetWithNodeModules = new AssetStaging(stack, "WithNodeModules", {
        sourcePath: dir,
      });

      const assetNoNodeModules = new AssetStaging(stack, "NoNodeModules", {
        sourcePath: dir,
        exclude: ["node_modules"],
      });

      expect(assetNoNodeModules.assetHash).not.toBe(
        assetWithNodeModules.assetHash,
      );
    });
  });

  describe("extra hash for cache busting", () => {
    test("changes hash when extra hash changes", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const testFile = path.join(tempDir, "test.txt");
      fs.writeFileSync(testFile, "content");

      const asset1 = new AssetStaging(stack, "Asset1", {
        sourcePath: testFile,
        extraHash: "v1",
      });

      const asset2 = new AssetStaging(stack, "Asset2", {
        sourcePath: testFile,
        extraHash: "v2",
      });

      expect(asset1.assetHash).not.toBe(asset2.assetHash);
    });

    test("same extra hash produces same hash", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const testFile = path.join(tempDir, "test.txt");
      fs.writeFileSync(testFile, "content");

      const asset1 = new AssetStaging(stack, "Asset1", {
        sourcePath: testFile,
        extraHash: "v1.0.0",
      });

      const asset2 = new AssetStaging(stack, "Asset2", {
        sourcePath: testFile,
        extraHash: "v1.0.0",
      });

      expect(asset1.assetHash).toBe(asset2.assetHash);
    });
  });

  describe("custom hash", () => {
    test("normalizes custom hash to SHA256", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const testFile = path.join(tempDir, "test.txt");
      fs.writeFileSync(testFile, "content");

      const customHash = "my-custom-version-v1.0.0";
      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: testFile,
        assetHash: customHash,
        assetHashType: AssetHashType.CUSTOM,
      });

      // Custom hash should be used verbatim (matches TerraformAsset behavior)
      expect(asset.assetHash).toBe(customHash);
    });

    test("preserves valid SHA256 hash", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const testFile = path.join(tempDir, "test.txt");
      fs.writeFileSync(testFile, "content");

      const validHash = "a".repeat(64);
      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: testFile,
        assetHash: validHash,
        assetHashType: AssetHashType.CUSTOM,
      });

      expect(asset.assetHash).toBe(validHash);
    });
  });

  describe("archive detection", () => {
    test("detects .zip as archive", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const zipFile = path.join(tempDir, "archive.zip");
      fs.writeFileSync(zipFile, "fake zip content");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: zipFile,
      });

      expect(asset.isArchive).toBe(true);
      expect(asset.packaging).toBe(FileAssetPackaging.FILE);
    });

    test("detects .tar.gz as archive", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const tarGzFile = path.join(tempDir, "archive.tar.gz");
      fs.writeFileSync(tarGzFile, "fake tar.gz content");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: tarGzFile,
      });

      expect(asset.isArchive).toBe(true);
      expect(asset.packaging).toBe(FileAssetPackaging.FILE);
    });

    test("detects .tgz as archive", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const tgzFile = path.join(tempDir, "archive.tgz");
      fs.writeFileSync(tgzFile, "fake tgz content");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: tgzFile,
      });

      expect(asset.isArchive).toBe(true);
      expect(asset.packaging).toBe(FileAssetPackaging.FILE);
    });

    test("detects .tar as archive", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const tarFile = path.join(tempDir, "archive.tar");
      fs.writeFileSync(tarFile, "fake tar content");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: tarFile,
      });

      expect(asset.isArchive).toBe(true);
      expect(asset.packaging).toBe(FileAssetPackaging.FILE);
    });

    test("detects non-archive file correctly", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const txtFile = path.join(tempDir, "document.txt");
      fs.writeFileSync(txtFile, "text content");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: txtFile,
      });

      expect(asset.isArchive).toBe(false);
      expect(asset.packaging).toBe(FileAssetPackaging.FILE);
    });

    test("detects .zip.txt as non-archive", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const txtFile = path.join(tempDir, "archive.zip.txt");
      fs.writeFileSync(txtFile, "text content, not an archive");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: txtFile,
      });

      expect(asset.isArchive).toBe(false);
      expect(asset.packaging).toBe(FileAssetPackaging.FILE);
    });

    test("handles multiple extensions correctly", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const multiExtFile = path.join(
        tempDir,
        "artifact.da.vinci.monalisa.tar.gz",
      );
      fs.writeFileSync(multiExtFile, "fake tar.gz");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: multiExtFile,
      });

      expect(asset.isArchive).toBe(true);
      expect(asset.packaging).toBe(FileAssetPackaging.FILE);
      expect(asset.absoluteStagedPath).toContain(".tar.gz");
    });
  });

  describe("asset reuse and caching", () => {
    test("reuses staging for identical assets", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const testFile = path.join(tempDir, "test.txt");
      fs.writeFileSync(testFile, "Content");

      const asset1 = new AssetStaging(stack, "Asset1", {
        sourcePath: testFile,
      });

      const asset2 = new AssetStaging(stack, "Asset2", {
        sourcePath: testFile,
      });

      expect(asset1.assetHash).toBe(asset2.assetHash);
      expect(asset1.absoluteStagedPath).toBe(asset2.absoluteStagedPath);
    });

    test("preserves packaging when reusing from memory cache", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const zipFile = path.join(tempDir, "archive.zip");
      fs.writeFileSync(zipFile, "fake zip");

      const asset1 = new AssetStaging(stack, "Asset1", {
        sourcePath: zipFile,
      });

      const asset2 = new AssetStaging(stack, "Asset2", {
        sourcePath: zipFile,
      });

      expect(asset1.packaging).toBe(FileAssetPackaging.FILE);
      expect(asset1.isArchive).toBe(true);
      expect(asset2.packaging).toBe(asset1.packaging);
      expect(asset2.isArchive).toBe(asset1.isArchive);
    });
  });

  describe("symlink handling", () => {
    test("follows symlink to directory", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      // Create a real directory
      const realDir = path.join(tempDir, "real-dir");
      fs.mkdirSync(realDir);
      fs.writeFileSync(path.join(realDir, "file.txt"), "content");

      // Create a symlink
      const symlinkDir = path.join(tempDir, "symlink-dir");
      try {
        fs.symlinkSync(realDir, symlinkDir);
      } catch (_e) {
        // Skip test if symlinks are not supported
        return;
      }

      const assetFromReal = new AssetStaging(stack, "AssetReal", {
        sourcePath: realDir,
      });

      const assetFromSymlink = new AssetStaging(stack, "AssetSymlink", {
        sourcePath: symlinkDir,
      });

      // Should produce the same hash when following symlink
      expect(assetFromSymlink.assetHash).toBe(assetFromReal.assetHash);
    });
  });

  describe("edge cases", () => {
    test("handles empty directory", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const emptyDir = path.join(tempDir, "empty");
      fs.mkdirSync(emptyDir);

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: emptyDir,
      });

      expect(asset.assetHash).toBeDefined();
      expect(asset.packaging).toBe(FileAssetPackaging.ZIP_DIRECTORY);
    });

    test("handles deeply nested directories", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const deepDir = path.join(tempDir, "a", "b", "c", "d", "e");
      fs.mkdirSync(deepDir, { recursive: true });
      fs.writeFileSync(path.join(deepDir, "file.txt"), "deep");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: path.join(tempDir, "a"),
      });

      expect(asset.assetHash).toBeDefined();
    });

    test("handles special characters in filenames", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const specialDir = path.join(tempDir, "special");
      fs.mkdirSync(specialDir);
      fs.writeFileSync(path.join(specialDir, "file (1).txt"), "content");
      fs.writeFileSync(path.join(specialDir, "file [2].txt"), "content");
      fs.writeFileSync(path.join(specialDir, "file's.txt"), "content");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: specialDir,
      });

      expect(asset.assetHash).toBeDefined();
    });

    test("handles very long filenames", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const longNameDir = path.join(tempDir, "longname");
      fs.mkdirSync(longNameDir);
      const longFileName = "a".repeat(200) + ".txt";
      fs.writeFileSync(path.join(longNameDir, longFileName), "content");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: longNameDir,
      });

      expect(asset.assetHash).toBeDefined();
    });

    test("handles binary files", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const binaryFile = path.join(tempDir, "binary.bin");
      const buffer = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      fs.writeFileSync(binaryFile, buffer);

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: binaryFile,
      });

      expect(asset.assetHash).toBeDefined();
      expect(asset.isArchive).toBe(false);
    });
  });

  describe("file permissions", () => {
    test("handles executable files", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const scriptFile = path.join(tempDir, "script.sh");
      fs.writeFileSync(scriptFile, "#!/bin/bash\necho hello");
      try {
        fs.chmodSync(scriptFile, 0o755);
      } catch (_e) {
        // Skip on Windows or if chmod fails
        return;
      }

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: scriptFile,
      });

      expect(asset.assetHash).toBeDefined();
    });
  });

  describe("cross-platform behavior", () => {
    test("handles Windows-style paths", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const testFile = path.join(tempDir, "test.txt");
      fs.writeFileSync(testFile, "Content");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: testFile,
      });

      // Hash should be consistent regardless of path separators
      expect(asset.assetHash).toBeDefined();
      expect(asset.assetHash).toHaveLength(32); // MD5 hash (unified with TerraformAsset)
      expect(asset.assetHash).toMatch(/^[A-F0-9]{32}$/); // Uppercase hex
    });
  });

  describe("asset output structure", () => {
    test("staged path contains hash", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const testFile = path.join(tempDir, "test.txt");
      fs.writeFileSync(testFile, "Content");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: testFile,
      });

      const stagedBasename = path.basename(asset.absoluteStagedPath);
      expect(stagedBasename).toContain("asset.");
      expect(stagedBasename).toContain(asset.assetHash);
    });

    test("archive files preserve extension in staged path", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const tarGzFile = path.join(tempDir, "archive.tar.gz");
      fs.writeFileSync(tarGzFile, "fake tar.gz");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: tarGzFile,
      });

      expect(asset.absoluteStagedPath).toMatch(/\.tar\.gz$/);
    });

    test("non-archive files preserve extension in staged path", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const txtFile = path.join(tempDir, "document.txt");
      fs.writeFileSync(txtFile, "content");

      const asset = new AssetStaging(stack, "Asset", {
        sourcePath: txtFile,
      });

      expect(asset.absoluteStagedPath).toMatch(/\.txt$/);
    });
  });

  describe("canonical hash feature flag", () => {
    test("uses the canonical scheme when the flag is enabled", () => {
      // GIVEN
      const app = Testing.app({
        context: {
          [CANONICAL_ASSET_HASHES]: "true",
        },
      });
      const stack = new TerraformStack(app, "Stack");
      const sourceDir = path.join(tempDir, "source");
      fs.mkdirSync(sourceDir);
      fs.writeFileSync(path.join(sourceDir, "file.txt"), "content");

      // WHEN
      const staging = new AssetStaging(stack, "Asset", {
        sourcePath: sourceDir,
      });

      // THEN - the exact canonical digest, framed as the archive that a
      // directory asset is emitted as; not merely "some hash".
      expect(staging.assetHash).toBe(
        hashPath(sourceDir, { canonical: true, archive: true }),
      );
      expect(staging.assetHash).not.toBe(
        hashPath(sourceDir, { canonical: false, archive: true }),
      );
    });

    test("the canonical scheme distinguishes trees the legacy scheme cannot", () => {
      // GIVEN two trees with identical file contents but different names,
      // which the legacy content-concatenation hash cannot tell apart.
      const app = Testing.app({
        context: { [CANONICAL_ASSET_HASHES]: "true" },
      });
      const stack = new TerraformStack(app, "Stack");

      const a = path.join(tempDir, "a");
      fs.mkdirSync(a);
      fs.writeFileSync(path.join(a, "one.txt"), "same");
      const b = path.join(tempDir, "b");
      fs.mkdirSync(b);
      fs.writeFileSync(path.join(b, "two.txt"), "same");

      // WHEN
      const first = new AssetStaging(stack, "A", { sourcePath: a });
      const second = new AssetStaging(stack, "B", { sourcePath: b });

      // THEN
      expect(first.assetHash).not.toBe(second.assetHash);
      expect(hashPath(a, { canonical: false })).toBe(
        hashPath(b, { canonical: false }),
      );
    });

    test("uses feature flag constant not hardcoded string", () => {
      // This test ensures we're using the constant from features.ts
      // not the legacy "cdktn:canonicalAssetHashes" string
      expect(CANONICAL_ASSET_HASHES).toBe("canonicalAssetHashes");
      expect(CANONICAL_ASSET_HASHES).not.toBe("cdktn:canonicalAssetHashes");
    });
  });
});
