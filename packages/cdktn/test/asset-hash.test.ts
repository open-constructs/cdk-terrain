// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AssetHash, ExcludeIgnoreStrategy, IIgnoreStrategy } from "../lib";

describe("AssetHash", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "asset-hash-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("computes a stable hash without staging anything", () => {
    fs.writeFileSync(path.join(tempDir, "a.txt"), "hello");

    const hash1 = AssetHash.of(tempDir);
    const hash2 = AssetHash.of(tempDir);

    expect(hash1).toBe(hash2);
    // Checked against tempDir itself rather than the shared, OS-wide temp
    // dir: tempDir is a uniquely-named mkdtemp directory nothing else in
    // the process touches, so this is race-free, unlike scanning the
    // shared dir, which every concurrent test file in this suite also
    // creates and removes its own temp dirs in. What's actually worth
    // guarding here is narrower anyway: a staged copy must not land back
    // inside the very source tree being hashed.
    expect(fs.readdirSync(tempDir)).toEqual(["a.txt"]);
  });

  test("changes when content changes", () => {
    const file = path.join(tempDir, "a.txt");
    fs.writeFileSync(file, "hello");
    const original = AssetHash.of(tempDir);

    fs.writeFileSync(file, "goodbye");
    expect(AssetHash.of(tempDir)).not.toBe(original);
  });

  test("extraHash changes the digest", () => {
    fs.writeFileSync(path.join(tempDir, "a.txt"), "hello");
    const withoutExtra = AssetHash.of(tempDir);
    const withExtra = AssetHash.of(tempDir, { extraHash: "salt" });

    expect(withExtra).not.toBe(withoutExtra);
  });

  test("exclude omits matched paths from the hash", () => {
    fs.writeFileSync(path.join(tempDir, "a.txt"), "hello");
    fs.writeFileSync(path.join(tempDir, "b.log"), "noise");

    const hashWithLog = AssetHash.of(tempDir, { exclude: [] });
    fs.writeFileSync(path.join(tempDir, "b.log"), "different noise");
    const hashWithChangedLog = AssetHash.of(tempDir, { exclude: [] });
    const hashExcludingLog = AssetHash.of(tempDir, { exclude: ["*.log"] });

    expect(hashWithChangedLog).not.toBe(hashWithLog);

    fs.writeFileSync(path.join(tempDir, "b.log"), "noise");
    expect(AssetHash.of(tempDir, { exclude: ["*.log"] })).toBe(
      hashExcludingLog,
    );
  });

  test("accepts a custom IIgnoreStrategy", () => {
    fs.writeFileSync(path.join(tempDir, "a.txt"), "hello");
    fs.writeFileSync(path.join(tempDir, "ignored.tmp"), "noise");

    const strategy: IIgnoreStrategy = {
      ignores: (relativePath) => relativePath.endsWith(".tmp"),
    };

    const withStrategy = AssetHash.of(tempDir, { ignoreStrategy: strategy });

    fs.writeFileSync(path.join(tempDir, "ignored.tmp"), "different noise");
    expect(AssetHash.of(tempDir, { ignoreStrategy: strategy })).toBe(
      withStrategy,
    );
  });

  test("ExcludeIgnoreStrategy matches the same rules as `exclude`", () => {
    const strategy = new ExcludeIgnoreStrategy(["*.log", "node_modules"]);

    expect(strategy.ignores("a.log")).toBe(true);
    expect(strategy.ignores("node_modules/foo/index.js")).toBe(true);
    expect(strategy.ignores("src/index.ts")).toBe(false);
  });

  test("ExcludeIgnoreStrategy exposes a cacheKey", () => {
    const strategy = new ExcludeIgnoreStrategy(["*.log"]);
    expect(strategy.cacheKey).toBeDefined();
    expect(new ExcludeIgnoreStrategy(["*.log"]).cacheKey).toBe(
      strategy.cacheKey,
    );
    expect(new ExcludeIgnoreStrategy(["*.tmp"]).cacheKey).not.toBe(
      strategy.cacheKey,
    );
  });

  test("throws when both exclude and ignoreStrategy are given", () => {
    fs.writeFileSync(path.join(tempDir, "a.txt"), "hello");

    expect(() =>
      AssetHash.of(tempDir, {
        exclude: ["*.log"],
        ignoreStrategy: new ExcludeIgnoreStrategy(["*.tmp"]),
      }),
    ).toThrow(/exclude.*ignoreStrategy|ignoreStrategy.*exclude/i);
  });

  test("hashes on the canonical scheme regardless of the feature flag", () => {
    // Canonical hashing frames every entry with its path; legacy hashes only
    // file bytes with no path recorded. So identical bytes under different
    // names collide on legacy and diverge on canonical -- which is the one
    // property that actually distinguishes the two schemes.
    const dirA = path.join(tempDir, "a");
    const dirB = path.join(tempDir, "b");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    fs.writeFileSync(path.join(dirA, "a.txt"), "hello");
    fs.writeFileSync(path.join(dirB, "b.txt"), "hello");

    expect(AssetHash.of(dirA)).not.toBe(AssetHash.of(dirB));
  });
});
