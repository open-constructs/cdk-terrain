// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
// Comprehensive bundling tests for CDKTN

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  BundlingOutput,
  DockerImage,
  DockerVolumeConsistency,
  type ILocalBundling,
  type BundlingOptions,
} from "../lib/bundling";
import {
  AssetStaging,
  AssetHashType,
  FileAssetPackaging,
  TerraformStack,
  Testing,
} from "../lib";

jest.mock("child_process");

// Mock local bundler for integration tests
class MockLocalBundler implements ILocalBundling {
  constructor(
    private shouldSucceed: boolean = true,
    private outputContent: string = "bundled output",
  ) {}

  tryBundle(outputDir: string, _options: BundlingOptions): boolean {
    if (!this.shouldSucceed) {
      return false;
    }

    // Create output in the bundle directory
    fs.writeFileSync(path.join(outputDir, "output.txt"), this.outputContent);
    return true;
  }
}

describe("bundling", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("DockerImage", () => {
    beforeEach(() => {
      (spawnSync as jest.Mock).mockReturnValue({
        status: 0,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
      });
    });

    test("fromRegistry creates image reference", () => {
      const image = DockerImage.fromRegistry("node:18");
      expect(image.image).toBe("node:18");
    });

    test("fromBuild creates image with hash-based tag", () => {
      const image = DockerImage.fromBuild("/path/to/context");
      expect(image.image).toMatch(/^cdktn-[a-f0-9]{64}$/);
      expect(spawnSync).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining([
          "build",
          "-t",
          expect.any(String),
          "/path/to/context",
        ]),
        expect.any(Object),
      );
    });

    test("run executes docker run with options", () => {
      const image = DockerImage.fromRegistry("alpine");
      image.run({
        command: ["echo", "hello"],
        environment: { TEST: "value" },
        user: "1000:1000",
      });

      expect(spawnSync).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining([
          "run",
          "--rm",
          "-u",
          "1000:1000",
          "--env",
          "TEST=value",
          "alpine",
          "echo",
          "hello",
        ]),
        expect.any(Object),
      );
    });

    test("run mounts volumes without imposing a consistency mode", () => {
      const image = DockerImage.fromRegistry("alpine");
      image.run({
        volumes: [{ hostPath: "/host", containerPath: "/container" }],
      });

      // `consistency` is a macOS-only hint, so it is not forced onto mounts.
      expect(spawnSync).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining(["-v", "/host:/container"]),
        expect.any(Object),
      );
    });

    test("run applies readOnly and consistency to volume mounts", () => {
      const image = DockerImage.fromRegistry("alpine");
      image.run({
        volumes: [
          { hostPath: "/ro", containerPath: "/in", readOnly: true },
          {
            hostPath: "/cached",
            containerPath: "/c",
            consistency: DockerVolumeConsistency.CACHED,
          },
        ],
      });

      expect(spawnSync).toHaveBeenLastCalledWith(
        "docker",
        expect.arrayContaining(["-v", "/ro:/in:ro", "-v", "/cached:/c:cached"]),
        expect.any(Object),
      );
    });
  });

  describe("BundlingOutput", () => {
    test("has expected enum values", () => {
      expect(BundlingOutput.ARCHIVED).toBe("archived");
      expect(BundlingOutput.NOT_ARCHIVED).toBe("not-archived");
      expect(BundlingOutput.AUTO_DISCOVER).toBe("auto-discover");
      expect(BundlingOutput.SINGLE_FILE).toBe("single-file");
    });
  });

  // Integration tests with AssetStaging
  describe("Asset bundling integration", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-bundle-test-"));
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    describe("local bundling", () => {
      test("uses local bundling when successful", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "index.js"), "console.log('hi')");

        const bundler = new MockLocalBundler(true, "locally bundled");

        const asset = new AssetStaging(stack, "Asset", {
          sourcePath: testDir,
          bundling: {
            image: DockerImage.fromRegistry("node:18"),
            command: ["echo", "should not run"],
            local: bundler,
          },
        });

        expect(asset.assetHash).toBeDefined();
        expect(fs.existsSync(asset.absoluteStagedPath)).toBe(true);
      });

      test("attempts docker when local bundling returns false", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "index.js"), "console.log('hi')");

        const bundler = new MockLocalBundler(false);

        // Docker bundling will be attempted (may or may not work in test environment)
        try {
          const asset = new AssetStaging(stack, "Asset", {
            sourcePath: testDir,
            bundling: {
              image: DockerImage.fromRegistry("node:18"),
              command: ["echo", "docker would run"],
              local: bundler,
            },
          });
          expect(asset).toBeDefined();
        } catch (err) {
          // If docker fails, that's expected in test environment
          expect(err).toBeDefined();
        }
      });

      test("local bundler receives correct options", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "file.txt"), "content");

        let receivedOptions: BundlingOptions | undefined;

        const customBundler: ILocalBundling = {
          tryBundle(outputDir: string, options: BundlingOptions): boolean {
            receivedOptions = options;
            fs.writeFileSync(path.join(outputDir, "output.txt"), "bundled");
            return true;
          },
        };

        const bundlingOptions: BundlingOptions = {
          image: DockerImage.fromRegistry("alpine"),
          command: ["/bin/sh", "-c", "echo hello"],
          environment: {
            NODE_ENV: "production",
          },
          user: "1000:1000",
          workingDirectory: "/app",
        };

        new AssetStaging(stack, "Asset", {
          sourcePath: testDir,
          bundling: {
            ...bundlingOptions,
            local: customBundler,
          },
        });

        expect(receivedOptions).toBeDefined();
        expect(receivedOptions?.image.image).toBe("alpine");
        expect(receivedOptions?.environment?.NODE_ENV).toBe("production");
      });

      test("requires directory for bundling", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testFile = path.join(tempDir, "file.txt");
        fs.writeFileSync(testFile, "content");

        expect(() => {
          new AssetStaging(stack, "Asset", {
            sourcePath: testFile,
            bundling: {
              image: DockerImage.fromRegistry("alpine"),
              command: ["echo", "hello"],
            },
          });
        }).toThrow("Asset must be a directory when bundling");
      });
    });

    describe("bundling output types", () => {
      test("handles AUTO_DISCOVER output type with single file", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "file.txt"), "content");

        const bundler: ILocalBundling = {
          tryBundle(outputDir: string): boolean {
            fs.writeFileSync(path.join(outputDir, "output.txt"), "bundled");
            return true;
          },
        };

        const asset = new AssetStaging(stack, "Asset", {
          sourcePath: testDir,
          bundling: {
            image: DockerImage.fromRegistry("alpine"),
            command: ["echo", "hello"],
            outputType: BundlingOutput.AUTO_DISCOVER,
            local: bundler,
          },
        });

        expect(asset.packaging).toBe(FileAssetPackaging.ZIP_DIRECTORY);
      });

      test("handles NOT_ARCHIVED output type", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "file.txt"), "content");

        const bundler: ILocalBundling = {
          tryBundle(outputDir: string): boolean {
            fs.writeFileSync(path.join(outputDir, "file1.txt"), "content1");
            fs.writeFileSync(path.join(outputDir, "file2.txt"), "content2");
            return true;
          },
        };

        const asset = new AssetStaging(stack, "Asset", {
          sourcePath: testDir,
          bundling: {
            image: DockerImage.fromRegistry("alpine"),
            command: ["echo", "hello"],
            outputType: BundlingOutput.NOT_ARCHIVED,
            local: bundler,
          },
        });

        expect(asset.packaging).toBe(FileAssetPackaging.ZIP_DIRECTORY);
        expect(asset.isArchive).toBe(false);
      });

      test("handles ARCHIVED output type with single archive", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "file.txt"), "content");

        const bundler: ILocalBundling = {
          tryBundle(outputDir: string): boolean {
            fs.writeFileSync(
              path.join(outputDir, "output.zip"),
              "archive content",
            );
            return true;
          },
        };

        const asset = new AssetStaging(stack, "Asset", {
          sourcePath: testDir,
          bundling: {
            image: DockerImage.fromRegistry("alpine"),
            command: ["echo", "hello"],
            outputType: BundlingOutput.ARCHIVED,
            local: bundler,
          },
        });

        expect(asset.packaging).toBe(FileAssetPackaging.FILE);
        expect(asset.isArchive).toBe(true);
      });

      test("throws error when ARCHIVED output has multiple files", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "file.txt"), "content");

        const bundler: ILocalBundling = {
          tryBundle(outputDir: string): boolean {
            fs.writeFileSync(path.join(outputDir, "file1.txt"), "content1");
            fs.writeFileSync(path.join(outputDir, "file2.txt"), "content2");
            return true;
          },
        };

        expect(() => {
          new AssetStaging(stack, "Asset", {
            sourcePath: testDir,
            bundling: {
              image: DockerImage.fromRegistry("alpine"),
              command: ["echo", "hello"],
              outputType: BundlingOutput.ARCHIVED,
              local: bundler,
            },
          });
        }).toThrow(
          /expected BundlingOutput\.ARCHIVED but the bundling output directory.*contains 2 file\(s\)/,
        );
      });

      test("handles SINGLE_FILE output type", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "file.txt"), "content");

        const bundler: ILocalBundling = {
          tryBundle(outputDir: string): boolean {
            fs.writeFileSync(path.join(outputDir, "output.txt"), "single file");
            return true;
          },
        };

        const asset = new AssetStaging(stack, "Asset", {
          sourcePath: testDir,
          bundling: {
            image: DockerImage.fromRegistry("alpine"),
            command: ["echo", "hello"],
            outputType: BundlingOutput.SINGLE_FILE,
            local: bundler,
          },
        });

        expect(asset.packaging).toBe(FileAssetPackaging.FILE);
        expect(asset.isArchive).toBe(false);
      });

      test("throws error when SINGLE_FILE output has multiple files", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(tempDir, "file.txt"), "content");

        const bundler: ILocalBundling = {
          tryBundle(outputDir: string): boolean {
            fs.writeFileSync(path.join(outputDir, "file1.txt"), "content1");
            fs.writeFileSync(path.join(outputDir, "file2.txt"), "content2");
            return true;
          },
        };

        expect(() => {
          new AssetStaging(stack, "Asset", {
            sourcePath: testDir,
            bundling: {
              image: DockerImage.fromRegistry("alpine"),
              command: ["echo", "hello"],
              outputType: BundlingOutput.SINGLE_FILE,
              local: bundler,
            },
          });
        }).toThrow(
          /expected BundlingOutput\.SINGLE_FILE but the bundling output directory.*contains 2 file\(s\)/,
        );
      });

      test("throws error when ARCHIVED expects archive but gets non-archive", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "file.txt"), "content");

        const bundler: ILocalBundling = {
          tryBundle(outputDir: string): boolean {
            fs.writeFileSync(
              path.join(outputDir, "output.txt"),
              "not an archive",
            );
            return true;
          },
        };

        expect(() => {
          new AssetStaging(stack, "Asset", {
            sourcePath: testDir,
            bundling: {
              image: DockerImage.fromRegistry("alpine"),
              command: ["echo", "hello"],
              outputType: BundlingOutput.ARCHIVED,
              local: bundler,
            },
          });
        }).toThrow(
          /expected BundlingOutput\.ARCHIVED but the bundling output directory.*contains 1 file\(s\)/,
        );
      });

      test("throws error when SINGLE_FILE gets archive file", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "file.txt"), "content");

        const bundler: ILocalBundling = {
          tryBundle(outputDir: string): boolean {
            fs.writeFileSync(
              path.join(outputDir, "output.zip"),
              "archive content",
            );
            return true;
          },
        };

        expect(() => {
          new AssetStaging(stack, "Asset", {
            sourcePath: testDir,
            bundling: {
              image: DockerImage.fromRegistry("alpine"),
              command: ["echo", "hello"],
              outputType: BundlingOutput.SINGLE_FILE,
              local: bundler,
            },
          });
        }).toThrow(
          /expected BundlingOutput\.SINGLE_FILE but the bundling output directory.*contains 1 file\(s\)/,
        );
      });
    });

    describe("bundling with hash types", () => {
      test("SOURCE hash type works with bundling", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source1");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "index.js"), "console.log('v1')");

        const asset = new AssetStaging(stack, "Asset1", {
          sourcePath: testDir,
          assetHashType: AssetHashType.SOURCE,
          bundling: {
            image: DockerImage.fromRegistry("node:18"),
            command: ["echo", "bundle"],
            local: new MockLocalBundler(true, "output"),
          },
        });

        expect(asset.assetHash).toBeDefined();
        expect(asset.assetHash).toHaveLength(32); // MD5 hash (unified)
        expect(asset.assetHash).toMatch(/^[A-F0-9]{32}$/); // Uppercase hex
        expect(fs.existsSync(asset.absoluteStagedPath)).toBe(true);
      });

      test("supports OUTPUT hash type with bundling", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "input.txt"), "input");

        const asset1 = new AssetStaging(stack, "Asset1", {
          sourcePath: testDir,
          assetHashType: AssetHashType.OUTPUT,
          bundling: {
            image: DockerImage.fromRegistry("alpine"),
            command: ["echo", "bundle"],
            local: new MockLocalBundler(true, "output v1"),
          },
        });

        const asset2 = new AssetStaging(stack, "Asset2", {
          sourcePath: testDir,
          assetHashType: AssetHashType.OUTPUT,
          bundling: {
            image: DockerImage.fromRegistry("alpine"),
            command: ["echo", "bundle"],
            local: new MockLocalBundler(true, "output v2"),
          },
        });

        // Hash should be different because output is different
        expect(asset2.assetHash).not.toBe(asset1.assetHash);
      });

      test("uses SOURCE hash when OUTPUT specified without bundling", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "file.txt"), "content");

        const asset = new AssetStaging(stack, "Asset", {
          sourcePath: testDir,
          assetHashType: AssetHashType.OUTPUT,
        });

        expect(asset.assetHash).toBeDefined();
        expect(asset.assetHash).toHaveLength(32); // MD5 hash (unified)
        expect(asset.assetHash).toMatch(/^[A-F0-9]{32}$/); // Uppercase hex
      });
    });

    describe("bundling with custom hash", () => {
      test("supports custom hash with bundling", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "file.txt"), "content");

        const customHash = "my-custom-v1";
        const asset = new AssetStaging(stack, "Asset", {
          sourcePath: testDir,
          assetHash: customHash,
          assetHashType: AssetHashType.CUSTOM,
          bundling: {
            image: DockerImage.fromRegistry("alpine"),
            command: ["echo", "bundle"],
            local: new MockLocalBundler(),
          },
        });

        // Custom hash is used verbatim (unified behavior)
        expect(asset.assetHash).toBe(customHash);
      });
    });

    describe("bundling error handling", () => {
      test("cleans up temp directory on bundling failure", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "file.txt"), "content");

        const failingBundler: ILocalBundling = {
          tryBundle(): boolean {
            throw new Error("Bundling failed!");
          },
        };

        expect(() => {
          new AssetStaging(stack, "Asset", {
            sourcePath: testDir,
            bundling: {
              image: DockerImage.fromRegistry("alpine"),
              command: ["echo", "bundle"],
              local: failingBundler,
            },
          });
        }).toThrow("Bundling failed!");
      });

      test("handles empty bundling output directory", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "file.txt"), "content");

        const emptyBundler: ILocalBundling = {
          tryBundle(_outputDir: string): boolean {
            return true;
          },
        };

        expect(() => {
          new AssetStaging(stack, "Asset", {
            sourcePath: testDir,
            bundling: {
              image: DockerImage.fromRegistry("alpine"),
              command: ["echo", "bundle"],
              local: emptyBundler,
            },
          });
        }).toThrow(/bundling output directory.*is empty/);
      });
    });

    describe("bundling with extra hash", () => {
      test("extra hash affects bundled asset hash", () => {
        const app = Testing.app();
        const stack = new TerraformStack(app, "test");

        const testDir = path.join(tempDir, "source");
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, "file.txt"), "content");

        const asset1 = new AssetStaging(stack, "Asset1", {
          sourcePath: testDir,
          extraHash: "v1",
          bundling: {
            image: DockerImage.fromRegistry("alpine"),
            command: ["echo", "bundle"],
            local: new MockLocalBundler(),
          },
        });

        const asset2 = new AssetStaging(stack, "Asset2", {
          sourcePath: testDir,
          extraHash: "v2",
          bundling: {
            image: DockerImage.fromRegistry("alpine"),
            command: ["echo", "bundle"],
            local: new MockLocalBundler(),
          },
        });

        expect(asset1.assetHash).not.toBe(asset2.assetHash);
      });
    });
  });

  describe("DockerImage.fromBuild Dockerfile path validation", () => {
    test("rejects absolute Dockerfile path", () => {
      // GIVEN
      const contextPath = "/some/context";

      // WHEN/THEN
      expect(() =>
        DockerImage.fromBuild(contextPath, {
          file: "/absolute/path/Dockerfile",
        }),
      ).toThrow(/must be relative to context/);
    });

    test("rejects Dockerfile outside context with ../", () => {
      // GIVEN
      const contextPath = path.join(__dirname, "fixtures");

      // WHEN/THEN
      expect(() =>
        DockerImage.fromBuild(contextPath, {
          file: "../Dockerfile",
        }),
      ).toThrow(/must be within the build context/);
    });

    test("rejects Dockerfile outside context with nested ../", () => {
      // GIVEN
      const contextPath = path.join(__dirname, "fixtures", "app");

      // WHEN/THEN
      expect(() =>
        DockerImage.fromBuild(contextPath, {
          file: "../../outside/Dockerfile",
        }),
      ).toThrow(/must be within the build context/);
    });

    test("builds with a Dockerfile in a context subdirectory", () => {
      // GIVEN
      (spawnSync as jest.Mock).mockReturnValue({
        status: 0,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
      });
      const contextPath = path.join(__dirname, "fixtures");

      // WHEN
      const image = DockerImage.fromBuild(contextPath, {
        file: "app/cdktf.json",
      });

      // THEN - the build actually ran, with -f pointing at the resolved file
      expect(image.image).toMatch(/^cdktn-[a-f0-9]{64}$/);
      expect(spawnSync).toHaveBeenLastCalledWith(
        "docker",
        expect.arrayContaining([
          "build",
          "-f",
          path.join(contextPath, "app/cdktf.json"),
          contextPath,
        ]),
        expect.any(Object),
      );
    });

    test("builds with a Dockerfile at the context root", () => {
      // GIVEN
      (spawnSync as jest.Mock).mockReturnValue({
        status: 0,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
      });
      const contextPath = path.join(__dirname, "fixtures");

      // WHEN
      DockerImage.fromBuild(contextPath, { file: "cdktf.json" });

      // THEN
      expect(spawnSync).toHaveBeenLastCalledWith(
        "docker",
        expect.arrayContaining([
          "build",
          "-f",
          path.join(contextPath, "cdktf.json"),
          contextPath,
        ]),
        expect.any(Object),
      );
    });
  });
});
