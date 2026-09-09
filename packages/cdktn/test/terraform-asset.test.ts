// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Testing, TerraformStack } from "../lib";
import { TerraformAsset, AssetType } from "../lib/terraform-asset";

describe("TerraformAsset Integration", () => {
  let tempDir: string;
  let testFile: string;
  let testDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-test-"));
    testFile = path.join(tempDir, "test.txt");
    testDir = path.join(tempDir, "testdir");

    fs.writeFileSync(testFile, "test content");
    fs.mkdirSync(testDir);
    fs.writeFileSync(path.join(testDir, "file1.txt"), "file 1 content");
    fs.writeFileSync(path.join(testDir, "file2.txt"), "file 2 content");
    fs.writeFileSync(path.join(testDir, "README.md"), "readme content");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Backwards Compatibility", () => {
    test("works with simple file asset (no advanced features)", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const asset = new TerraformAsset(stack, "Asset", {
        path: testFile,
      });

      expect(asset.assetHash).toBeDefined();
      expect(asset.type).toBe(AssetType.FILE);
      expect(asset.path).toContain("assets");
    });

    test("works with directory asset (no advanced features)", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const asset = new TerraformAsset(stack, "Asset", {
        path: testDir,
        type: AssetType.DIRECTORY,
      });

      expect(asset.assetHash).toBeDefined();
      expect(asset.type).toBe(AssetType.DIRECTORY);
    });

    test("works with archive type (no advanced features)", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const asset = new TerraformAsset(stack, "Asset", {
        path: testDir,
        type: AssetType.ARCHIVE,
      });

      expect(asset.assetHash).toBeDefined();
      expect(asset.type).toBe(AssetType.ARCHIVE);
    });

    test("works with custom asset hash (no advanced features)", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const asset = new TerraformAsset(stack, "Asset", {
        path: testFile,
        assetHash: "custom-hash-123",
      });

      expect(asset.assetHash).toBeDefined();
      // Custom hash is used as-is in simple mode
      expect(asset.assetHash).toBe("custom-hash-123");
    });
  });

  describe("New Features (AssetStaging Integration)", () => {
    test("supports exclusion patterns", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const asset = new TerraformAsset(stack, "Asset", {
        path: testDir,
        exclude: ["*.md"],
      });

      expect(asset.assetHash).toBeDefined();
      expect(asset.type).toBe(AssetType.ARCHIVE);

      // Hash should be different than without exclusions
      const assetNoExclude = new TerraformAsset(stack, "Asset2", {
        path: testDir,
      });

      expect(asset.assetHash).not.toBe(assetNoExclude.assetHash);
    });

    test("supports extra hash for cache busting", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const asset1 = new TerraformAsset(stack, "Asset1", {
        path: testFile,
        extraHash: "v1.0.0",
      });

      const asset2 = new TerraformAsset(stack, "Asset2", {
        path: testFile,
        extraHash: "v2.0.0",
      });

      expect(asset1.assetHash).not.toBe(asset2.assetHash);
    });

    test("hash changes when excluding different files", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const asset1 = new TerraformAsset(stack, "Asset1", {
        path: testDir,
        exclude: ["*.md"],
      });

      const asset2 = new TerraformAsset(stack, "Asset2", {
        path: testDir,
        exclude: ["file1.txt"],
      });

      expect(asset1.assetHash).not.toBe(asset2.assetHash);
    });

    test("supports AssetHashType.SOURCE explicitly", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const asset = new TerraformAsset(stack, "Asset", {
        path: testFile,
        assetHashType: 0, // AssetHashType.SOURCE
      });

      expect(asset.assetHash).toBeDefined();
      expect(asset.type).toBe(AssetType.FILE);
    });

    test("synthesizes correctly with advanced features", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      new TerraformAsset(stack, "Asset", {
        path: testDir,
        exclude: ["*.md"],
        extraHash: "v1.0.0",
      });

      // Should not throw
      expect(() => app.synth()).not.toThrow();
    });
  });

  describe("Synthesis", () => {
    test("stages asset to correct location during synth", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const asset = new TerraformAsset(stack, "Asset", {
        path: testFile,
      });

      const output = Testing.synth(stack);
      expect(output).toBeDefined();

      // The asset should be staged
      expect(asset.path).toContain("assets");
      expect(asset.assetHash).toBeDefined();
    });

    test("stages asset with exclusions correctly", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      new TerraformAsset(stack, "Asset", {
        path: testDir,
        exclude: ["*.md"],
      });

      const output = Testing.synth(stack);
      expect(output).toBeDefined();
    });
  });

  describe("Advanced Feature Combinations", () => {
    test("combines exclusions with extra hash", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const asset = new TerraformAsset(stack, "Asset", {
        path: testDir,
        exclude: ["*.md"],
        extraHash: "build-v1.2.3",
      });

      expect(asset.assetHash).toBeDefined();
      expect(asset.type).toBe(AssetType.ARCHIVE);

      // Hash should differ from both: no exclusions, and no extra hash
      const noExclude = new TerraformAsset(stack, "Asset2", {
        path: testDir,
        extraHash: "build-v1.2.3",
      });
      const noExtra = new TerraformAsset(stack, "Asset3", {
        path: testDir,
        exclude: ["*.md"],
      });

      expect(asset.assetHash).not.toBe(noExclude.assetHash);
      expect(asset.assetHash).not.toBe(noExtra.assetHash);
    });

    test("explicit type overrides inferred type with advanced features", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const asset = new TerraformAsset(stack, "Asset", {
        path: testDir,
        type: AssetType.DIRECTORY, // Explicit DIRECTORY
        exclude: ["*.md"], // Advanced feature
      });

      expect(asset.type).toBe(AssetType.DIRECTORY);
      expect(asset.assetHash).toBeDefined();
    });

    test("custom hash with advanced features uses custom hash", () => {
      const app = Testing.app();
      const stack = new TerraformStack(app, "test");

      const customHash = "my-custom-hash";
      const asset = new TerraformAsset(stack, "Asset", {
        path: testDir,
        assetHash: customHash,
        exclude: ["*.md"], // This triggers AssetStaging
      });

      // Custom hash should be used verbatim (unified behavior with AssetStaging)
      expect(asset.assetHash).toBe(customHash);
    });
  });
});
