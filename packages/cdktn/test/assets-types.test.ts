// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AssetHash,
  AssetHashType,
  AssetPackaging,
  ExcludeIgnoreStrategy,
  type IIgnoreStrategy,
  type StagedAsset,
  type AssetOptions,
} from "../lib";

describe("Assets Types", () => {
  describe("AssetHashType", () => {
    test("has expected values", () => {
      expect(AssetHashType.SOURCE).toBe("source");
      expect(AssetHashType.OUTPUT).toBe("output");
      expect(AssetHashType.CUSTOM).toBe("custom");
    });
  });

  describe("AssetPackaging", () => {
    test("has expected shapes", () => {
      expect(AssetPackaging.FILE.producesDirectory).toBe(false);
      expect(AssetPackaging.DIRECTORY.producesDirectory).toBe(true);
      expect(AssetPackaging.ZIP.producesDirectory).toBe(false);
      expect(AssetPackaging.ZIP.extension).toBe(".zip");
    });

    describe("pack", () => {
      let tempDir: string;
      let source: string;

      beforeEach(() => {
        tempDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "asset-packaging-test-"),
        );
        source = path.join(tempDir, "source");
        fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, "a.txt"), "keep");
        fs.writeFileSync(path.join(source, "b.log"), "drop");
      });

      afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
      });

      test("DIRECTORY omits paths the ignoreStrategy excludes", () => {
        const target = path.join(tempDir, "target");
        AssetPackaging.DIRECTORY.pack({
          source,
          target,
          ignoreStrategy: new ExcludeIgnoreStrategy(["*.log"]),
        });

        expect(fs.existsSync(path.join(target, "a.txt"))).toBe(true);
        expect(fs.existsSync(path.join(target, "b.log"))).toBe(false);
      });

      test("ZIP omits paths the ignoreStrategy excludes", () => {
        const target = path.join(tempDir, "target.zip");
        AssetPackaging.ZIP.pack({
          source,
          target,
          ignoreStrategy: new ExcludeIgnoreStrategy(["*.log"]),
        });

        const zipped = fs.readFileSync(target);
        expect(zipped.toString("latin1")).toContain("a.txt");
        expect(zipped.toString("latin1")).not.toContain("b.log");
      });

      test("DIRECTORY re-includes a file below an excluded dir when pruning is off", () => {
        fs.mkdirSync(path.join(source, "node_modules"));
        fs.writeFileSync(path.join(source, "node_modules", "junk.js"), "junk");
        fs.writeFileSync(path.join(source, "node_modules", "keep.js"), "keep");

        const strategy: IIgnoreStrategy = {
          pruneExcludedDirectories: false,
          ignores: ({ relativePath }) =>
            (relativePath === "node_modules" ||
              relativePath.startsWith("node_modules/")) &&
            relativePath !== "node_modules/keep.js",
        };

        const target = path.join(tempDir, "target");
        AssetPackaging.DIRECTORY.pack({
          source,
          target,
          ignoreStrategy: strategy,
        });

        expect(
          fs.existsSync(path.join(target, "node_modules", "keep.js")),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(target, "node_modules", "junk.js")),
        ).toBe(false);

        // The packed tree and a hash of the source under the same strategy
        // describe the same file set: hashing the staged copy with no
        // exclusions matches hashing the source through the strategy.
        expect(AssetHash.of(target)).toBe(
          AssetHash.of(source, { ignoreStrategy: strategy }),
        );
      });

      test("passes isDirectory to the strategy so directory-only patterns work", () => {
        // A file and a directory share the name `build`. A directory-only
        // strategy must drop the directory while keeping the file, which is
        // only possible because pack tells it which entry is which.
        fs.mkdirSync(path.join(source, "build"));
        fs.writeFileSync(path.join(source, "build", "out.o"), "artifact");
        fs.writeFileSync(path.join(source, "build.txt"), "not the dir");

        const strategy: IIgnoreStrategy = {
          ignores: ({ relativePath, isDirectory }) =>
            isDirectory && relativePath === "build",
        };

        const target = path.join(tempDir, "target");
        AssetPackaging.DIRECTORY.pack({
          source,
          target,
          ignoreStrategy: strategy,
        });

        expect(fs.existsSync(path.join(target, "build"))).toBe(false);
        expect(fs.existsSync(path.join(target, "build.txt"))).toBe(true);
      });
    });
  });

  describe("StagedAsset", () => {
    test("can represent a staged file", () => {
      const asset: StagedAsset = {
        assetHash: "abc123",
        path: "assets/asset.abc123.zip",
        isDirectory: false,
      };

      expect(asset.assetHash).toBe("abc123");
      expect(asset.path).toBe("assets/asset.abc123.zip");
      expect(asset.isDirectory).toBe(false);
    });

    test("can represent a staged directory", () => {
      const asset: StagedAsset = {
        assetHash: "def456",
        path: "assets/asset.def456",
        isDirectory: true,
      };

      expect(asset.isDirectory).toBe(true);
    });
  });

  describe("AssetOptions", () => {
    test("can specify custom hash", () => {
      const options: AssetOptions = {
        assetHash: "my-custom-hash",
        assetHashType: AssetHashType.CUSTOM,
      };

      expect(options.assetHash).toBe("my-custom-hash");
      expect(options.assetHashType).toBe(AssetHashType.CUSTOM);
    });

    test("can specify hash type without custom hash", () => {
      const options: AssetOptions = {
        assetHashType: AssetHashType.SOURCE,
      };

      expect(options.assetHashType).toBe(AssetHashType.SOURCE);
      expect(options.assetHash).toBeUndefined();
    });
  });
});
