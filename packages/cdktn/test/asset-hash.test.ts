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
      ignores: ({ relativePath }) => relativePath.endsWith(".tmp"),
    };

    const withStrategy = AssetHash.of(tempDir, { ignoreStrategy: strategy });

    fs.writeFileSync(path.join(tempDir, "ignored.tmp"), "different noise");
    expect(AssetHash.of(tempDir, { ignoreStrategy: strategy })).toBe(
      withStrategy,
    );
  });

  test("descends into excluded directories when the strategy opts out of pruning", () => {
    fs.mkdirSync(path.join(tempDir, "node_modules"));
    fs.writeFileSync(path.join(tempDir, "node_modules", "junk.js"), "junk");
    fs.writeFileSync(path.join(tempDir, "node_modules", "keep.js"), "keep");

    // A negation strategy: exclude the whole `node_modules` tree, but re-include
    // `node_modules/keep.js`. Reachable only because pruning is off, so the walk
    // descends into the excluded directory and asks about its children.
    const strategy: IIgnoreStrategy = {
      pruneExcludedDirectories: false,
      ignores: ({ relativePath }) =>
        (relativePath === "node_modules" ||
          relativePath.startsWith("node_modules/")) &&
        relativePath !== "node_modules/keep.js",
    };

    const withStrategy = AssetHash.of(tempDir, { ignoreStrategy: strategy });

    // The re-included file is part of the hash: changing it moves the digest.
    fs.writeFileSync(path.join(tempDir, "node_modules", "keep.js"), "changed");
    expect(AssetHash.of(tempDir, { ignoreStrategy: strategy })).not.toBe(
      withStrategy,
    );

    // A sibling still under exclusion is not: changing it does not.
    fs.writeFileSync(path.join(tempDir, "node_modules", "keep.js"), "keep");
    fs.writeFileSync(
      path.join(tempDir, "node_modules", "junk.js"),
      "more junk",
    );
    expect(AssetHash.of(tempDir, { ignoreStrategy: strategy })).toBe(
      withStrategy,
    );
  });

  test("prunes excluded directories by default", () => {
    fs.mkdirSync(path.join(tempDir, "node_modules"));
    fs.writeFileSync(path.join(tempDir, "node_modules", "keep.js"), "keep");

    // Same negation shape, but pruning left at its default. The walk never
    // descends into the excluded directory, so the `!keep.js` re-include is
    // unreachable and the file does not affect the hash.
    const strategy: IIgnoreStrategy = {
      ignores: ({ relativePath }) =>
        (relativePath === "node_modules" ||
          relativePath.startsWith("node_modules/")) &&
        relativePath !== "node_modules/keep.js",
    };

    const withStrategy = AssetHash.of(tempDir, { ignoreStrategy: strategy });

    fs.writeFileSync(path.join(tempDir, "node_modules", "keep.js"), "changed");
    expect(AssetHash.of(tempDir, { ignoreStrategy: strategy })).toBe(
      withStrategy,
    );
  });

  test("ExcludeIgnoreStrategy matches the same rules as `exclude`", () => {
    const strategy = new ExcludeIgnoreStrategy(["*.log", "node_modules"]);

    expect(
      strategy.ignores({ relativePath: "a.log", isDirectory: false }),
    ).toBe(true);
    expect(
      strategy.ignores({
        relativePath: "node_modules/foo/index.js",
        isDirectory: false,
      }),
    ).toBe(true);
    expect(
      strategy.ignores({ relativePath: "src/index.ts", isDirectory: false }),
    ).toBe(false);
  });

  test("passes isDirectory through to a custom strategy", () => {
    fs.mkdirSync(path.join(tempDir, "keep"));
    fs.writeFileSync(path.join(tempDir, "keep", "a.txt"), "hello");
    fs.mkdirSync(path.join(tempDir, "drop"));
    fs.writeFileSync(path.join(tempDir, "drop", "b.txt"), "noise");

    // A directory-only strategy: excludes the `drop` directory but would keep
    // a file of the same name. It can only make that call because the walker
    // tells it the entry is a directory.
    const strategy: IIgnoreStrategy = {
      ignores: ({ relativePath, isDirectory }) =>
        isDirectory && relativePath === "drop",
    };

    const withStrategy = AssetHash.of(tempDir, { ignoreStrategy: strategy });

    // Changing content under the excluded directory does not move the hash.
    fs.writeFileSync(path.join(tempDir, "drop", "b.txt"), "different noise");
    expect(AssetHash.of(tempDir, { ignoreStrategy: strategy })).toBe(
      withStrategy,
    );

    // Changing content under the kept directory does move it.
    fs.writeFileSync(path.join(tempDir, "keep", "a.txt"), "changed");
    expect(AssetHash.of(tempDir, { ignoreStrategy: strategy })).not.toBe(
      withStrategy,
    );
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

  describe("relative path resolution", () => {
    let projectRoot: string;
    let originalCwd: string;

    beforeEach(() => {
      // realpath so comparisons hold on macOS, where os.tmpdir() lives under
      // the /var -> /private/var symlink.
      projectRoot = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "asset-hash-project-")),
      );
      fs.writeFileSync(path.join(projectRoot, "cdktf.json"), "{}");
      fs.mkdirSync(path.join(projectRoot, "assets", "thing"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(projectRoot, "assets", "thing", "a.txt"),
        "hello",
      );
      originalCwd = process.cwd();
    });

    afterEach(() => {
      process.chdir(originalCwd);
      fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    test("resolves a relative path against cdktf.json, not the cwd", () => {
      // Run from a nested subdirectory so cwd-based resolution would look in
      // the wrong place; only cdktf.json-based resolution finds the source.
      const nested = path.join(projectRoot, "assets", "thing");
      process.chdir(nested);

      const viaRelative = AssetHash.of("./assets/thing");
      const viaAbsolute = AssetHash.of(path.join(projectRoot, "assets/thing"));

      expect(viaRelative).toBe(viaAbsolute);
    });

    test("throws when a relative path has no cdktf.json above the cwd", () => {
      // A sibling temp tree with no cdktf.json anywhere above it.
      const orphan = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "asset-hash-orphan-")),
      );
      process.chdir(orphan);
      try {
        expect(() => AssetHash.of("./whatever")).toThrow(/cdktf\.json/);
      } finally {
        fs.rmSync(orphan, { recursive: true, force: true });
      }
    });

    test("uses an absolute path as-is without needing cdktf.json", () => {
      const orphan = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "asset-hash-orphan-")),
      );
      fs.writeFileSync(path.join(orphan, "a.txt"), "hello");
      process.chdir(orphan);
      try {
        // No cdktf.json above orphan, but an absolute path never consults it.
        expect(() => AssetHash.of(orphan)).not.toThrow();
      } finally {
        fs.rmSync(orphan, { recursive: true, force: true });
      }
    });
  });
});
