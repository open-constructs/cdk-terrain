// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { unzipSync } from "fflate";
import { archiveSync } from "../src/private/fs";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-archive-test-"));
}

/**
 * Extracts a zip to a temp directory using the system `unzip` command
 * and returns a map of relative paths to their contents.
 */
function extractZip(zipPath: string): Map<string, Buffer> {
  const extractDir = createTempDir();
  execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, {
    stdio: "ignore",
  });
  const result = new Map<string, Buffer>();
  function walk(dir: string, prefix: string) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (fs.statSync(full).isDirectory()) {
        walk(full, rel);
      } else {
        result.set(rel, fs.readFileSync(full));
      }
    }
  }
  walk(extractDir, "");
  fs.rmSync(extractDir, { recursive: true, force: true });
  return result;
}

describe("archiveSync", () => {
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

  test("creates a valid zip from a single file", () => {
    fs.writeFileSync(path.join(srcDir, "hello.txt"), "hello world");

    const zipPath = path.join(destDir, "output.zip");
    archiveSync(srcDir, zipPath);

    expect(fs.existsSync(zipPath)).toBe(true);
    const files = extractZip(zipPath);
    expect(files.size).toBe(1);
    expect(files.get("hello.txt")!.toString("utf-8")).toBe("hello world");
  });

  test("creates a valid zip from multiple files", () => {
    fs.writeFileSync(path.join(srcDir, "a.txt"), "aaa");
    fs.writeFileSync(path.join(srcDir, "b.txt"), "bbb");

    const zipPath = path.join(destDir, "output.zip");
    archiveSync(srcDir, zipPath);

    const files = extractZip(zipPath);
    expect(files.size).toBe(2);
    expect(files.get("a.txt")!.toString("utf-8")).toBe("aaa");
    expect(files.get("b.txt")!.toString("utf-8")).toBe("bbb");
  });

  test("preserves subdirectory structure", () => {
    fs.mkdirSync(path.join(srcDir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(srcDir, "root.txt"), "root");
    fs.writeFileSync(path.join(srcDir, "sub", "nested.txt"), "nested");

    const zipPath = path.join(destDir, "output.zip");
    archiveSync(srcDir, zipPath);

    const files = extractZip(zipPath);
    expect(files.size).toBe(2);
    expect(files.get("root.txt")!.toString("utf-8")).toBe("root");
    expect(files.get("sub/nested.txt")!.toString("utf-8")).toBe("nested");
  });

  test("handles deeply nested directories", () => {
    const deepDir = path.join(srcDir, "a", "b", "c");
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(path.join(deepDir, "deep.txt"), "deep content");

    const zipPath = path.join(destDir, "output.zip");
    archiveSync(srcDir, zipPath);

    const files = extractZip(zipPath);
    expect(files.size).toBe(1);
    expect(files.get("a/b/c/deep.txt")!.toString("utf-8")).toBe("deep content");
  });

  test("handles empty directories (no files to include)", () => {
    fs.mkdirSync(path.join(srcDir, "empty"), { recursive: true });

    const zipPath = path.join(destDir, "output.zip");
    archiveSync(srcDir, zipPath);

    expect(fs.existsSync(zipPath)).toBe(true);
    // unzip returns non-zero for empty archives, so check the file size
    // is minimal (just zip headers, no file entries)
    const zipSize = fs.statSync(zipPath).size;
    expect(zipSize).toBeLessThan(100);
  });

  test("handles binary content", () => {
    const binaryContent = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f]);
    fs.writeFileSync(path.join(srcDir, "binary.bin"), binaryContent);

    const zipPath = path.join(destDir, "output.zip");
    archiveSync(srcDir, zipPath);

    const files = extractZip(zipPath);
    expect(files.size).toBe(1);
    expect(files.get("binary.bin")).toEqual(binaryContent);
  });

  test("handles empty files", () => {
    fs.writeFileSync(path.join(srcDir, "empty.txt"), "");

    const zipPath = path.join(destDir, "output.zip");
    archiveSync(srcDir, zipPath);

    const files = extractZip(zipPath);
    expect(files.size).toBe(1);
    expect(files.get("empty.txt")!.toString("utf-8")).toBe("");
  });

  test("compresses content (output is smaller than input for repetitive data)", () => {
    const repetitive = "a".repeat(10000);
    fs.writeFileSync(path.join(srcDir, "big.txt"), repetitive);

    const zipPath = path.join(destDir, "output.zip");
    archiveSync(srcDir, zipPath);

    const zipSize = fs.statSync(zipPath).size;
    expect(zipSize).toBeLessThan(repetitive.length);
  });

  test("throws on nonexistent source directory", () => {
    const zipPath = path.join(destDir, "output.zip");
    expect(() => archiveSync("/nonexistent/path", zipPath)).toThrow();
  });
});

describe("archiveSync fflate regression", () => {
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

  test("fflate unzipSync round-trips byte-for-byte", () => {
    const inputs: Record<string, Buffer> = {
      "a.txt": Buffer.from("alpha"),
      "nested/b.txt": Buffer.from("beta beta beta"),
      "binary.bin": Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f]),
      "empty.txt": Buffer.from(""),
    };
    for (const [rel, content] of Object.entries(inputs)) {
      const full = path.join(srcDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }

    const zipPath = path.join(destDir, "output.zip");
    archiveSync(srcDir, zipPath);

    const unzipped = unzipSync(fs.readFileSync(zipPath));
    expect(Object.keys(unzipped).sort()).toEqual(Object.keys(inputs).sort());
    for (const [rel, expected] of Object.entries(inputs)) {
      expect(Buffer.from(unzipped[rel])).toEqual(expected);
    }
  });

  test("output is a structurally valid ZIP archive", () => {
    fs.writeFileSync(path.join(srcDir, "a.txt"), "hello");
    const zipPath = path.join(destDir, "output.zip");
    archiveSync(srcDir, zipPath);

    const bytes = fs.readFileSync(zipPath);
    // Local file header signature at offset 0: PK\x03\x04
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    // End of central directory record signature must appear in the tail
    const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    expect(bytes.lastIndexOf(eocd)).toBeGreaterThan(0);
  });

  test("level: 9 actually engages compression", () => {
    // 64 KiB of repetitive data must compress to well under the level-1
    // ceiling we'd expect from a stored-or-barely-deflated stream.
    const repetitive = Buffer.alloc(64 * 1024, "a");
    fs.writeFileSync(path.join(srcDir, "big.txt"), repetitive);

    const zipPath = path.join(destDir, "output.zip");
    archiveSync(srcDir, zipPath);

    const zipSize = fs.statSync(zipPath).size;
    // At level 9, 64 KiB of one byte should compress to a few hundred bytes
    // including ZIP framing. 2 KiB is a generous ceiling that still catches
    // any future regression to store-mode or near-zero compression.
    expect(zipSize).toBeLessThan(2048);
  });
});
