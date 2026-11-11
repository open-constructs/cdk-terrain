// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AssetHashType,
  AssetPackaging,
  AssetStaging,
  ASSET_HASH_SALT_CONTEXT_KEY,
  BundleResult,
  ChainBundler,
  ExcludeIgnoreStrategy,
  type IAssetPackaging,
  TerraformStack,
  Testing,
} from "../src";
import { CANONICAL_ASSET_HASHES } from "../src/features";
import { hashPath } from "../src/private/fs";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-asset-staging-test-"));
}

describe("AssetStaging", () => {
  let srcDir: string;

  beforeEach(() => {
    srcDir = createTempDir();
    fs.writeFileSync(path.join(srcDir, "a.txt"), "content");
    fs.writeFileSync(path.join(srcDir, "b.md"), "docs");
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  const stack = (canonical = true) =>
    new TerraformStack(
      canonical
        ? Testing.app({ context: { [CANONICAL_ASSET_HASHES]: "true" } })
        : Testing.app({ enableFutureFlags: false }),
      "s",
    );

  test("implements IAsset", () => {
    const staging = new AssetStaging(stack(), "staging", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
    });

    expect(typeof staging.assetHash).toBe("string");
  });

  test("SOURCE and OUTPUT hash the source identically", () => {
    const source = new AssetStaging(stack(), "source", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
      assetHashType: AssetHashType.SOURCE,
    });
    const output = new AssetStaging(stack(), "output", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
      assetHashType: AssetHashType.OUTPUT,
    });

    expect(output.assetHash).toEqual(source.assetHash);
    expect(source.assetHash).toEqual(hashPath(srcDir, { canonical: true }));
  });

  test("CUSTOM uses the provided assetHash verbatim", () => {
    const staging = new AssetStaging(stack(), "staging", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
      assetHash: "my-custom-hash",
      assetHashType: AssetHashType.CUSTOM,
    });

    expect(staging.assetHash).toBe("my-custom-hash");
  });

  test("CUSTOM without an assetHash throws", () => {
    expect(
      () =>
        new AssetStaging(stack(), "staging", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          assetHashType: AssetHashType.CUSTOM,
        }),
    ).toThrow(/CUSTOM/);
  });

  test("an assetHash with a non-CUSTOM type throws", () => {
    expect(
      () =>
        new AssetStaging(stack(), "staging", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          assetHash: "my-custom-hash",
          assetHashType: AssetHashType.SOURCE,
        }),
    ).toThrow(/CUSTOM/);
  });

  test("a custom assetHash with unsafe characters throws", () => {
    expect(
      () =>
        new AssetStaging(stack(), "staging", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          assetHash: "not/a/safe/hash",
          assetHashType: AssetHashType.CUSTOM,
        }),
    ).toThrow(/may only contain/);
  });

  test("an out-of-range hash type throws", () => {
    expect(
      () =>
        new AssetStaging(stack(), "staging", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          assetHashType: "bogus" as unknown as AssetHashType,
        }),
    ).toThrow(/unknown assetHashType/i);
  });

  test("exclude changes the hash relative to the unexcluded source", () => {
    const plain = new AssetStaging(stack(), "plain", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
    });
    const excluded = new AssetStaging(stack(), "excluded", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
      exclude: ["*.md"],
    });

    expect(excluded.assetHash).not.toEqual(plain.assetHash);
  });

  test("exclude and ignoreStrategy together throw", () => {
    expect(
      () =>
        new AssetStaging(stack(), "staging", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          exclude: ["*.md"],
          ignoreStrategy: new ExcludeIgnoreStrategy([]),
        }),
    ).toThrow(/exclude.*ignoreStrategy|ignoreStrategy/i);
  });

  test("extraHash changes the hash", () => {
    const withoutExtra = new AssetStaging(stack(), "without", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
    });
    const withExtra = new AssetStaging(stack(), "with", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
      extraHash: "v2",
    });

    expect(withExtra.assetHash).not.toEqual(withoutExtra.assetHash);
  });

  test("the canonicalAssetHashes flag gates which scheme is used", () => {
    const canonicalOn = new AssetStaging(stack(true), "on", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
    });
    const canonicalOff = new AssetStaging(stack(false), "off", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
    });

    expect(canonicalOn.assetHash).toEqual(
      hashPath(srcDir, { canonical: true }),
    );
    expect(canonicalOff.assetHash).toEqual(
      hashPath(srcDir, { canonical: false }),
    );
    expect(canonicalOn.assetHash).not.toEqual(canonicalOff.assetHash);
  });

  test("stage() copies content while honoring exclude, and hash/content agree", () => {
    const s = stack();
    const staging = new AssetStaging(s, "staging", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
      exclude: ["*.md"],
    });
    const targetPath = path.join(createTempDir(), "out");
    fs.mkdirSync(targetPath, { recursive: true });

    staging.stage(targetPath);

    expect(fs.existsSync(path.join(targetPath, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(targetPath, "b.md"))).toBe(false);
    expect(staging.assetHash).toEqual(
      hashPath(srcDir, {
        canonical: true,
        shouldExclude: (relativePath) => relativePath.endsWith(".md"),
      }),
    );
  });

  test("identical inputs on the same root reuse the cached hash instead of re-reading the source", () => {
    const s = stack();

    const first = new AssetStaging(s, "first", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
    });

    // If the second instance didn't hit the cache, it would try to walk a
    // directory that no longer exists and throw.
    fs.rmSync(srcDir, { recursive: true, force: true });

    const second = new AssetStaging(s, "second", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
    });

    expect(second.assetHash).toEqual(first.assetHash);
  });

  test("a different root does not reuse another root's cache (no stale hash after a source change)", () => {
    const first = new AssetStaging(stack(), "first", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
    });

    fs.writeFileSync(path.join(srcDir, "a.txt"), "changed content");

    const second = new AssetStaging(stack(), "second", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
    });

    expect(second.assetHash).not.toEqual(first.assetHash);
    expect(second.assetHash).toEqual(hashPath(srcDir, { canonical: true }));
  });

  test("ASSET_HASH_SALT_CONTEXT_KEY changes the hash for every asset in the tree", () => {
    const withoutSalt = new AssetStaging(stack(), "without", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
    });

    const saltedStack = new TerraformStack(
      Testing.app({
        context: {
          [CANONICAL_ASSET_HASHES]: "true",
          [ASSET_HASH_SALT_CONTEXT_KEY]: "bump-everything",
        },
      }),
      "s",
    );
    const withSalt = new AssetStaging(saltedStack, "with", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
    });

    expect(withSalt.assetHash).not.toEqual(withoutSalt.assetHash);
  });

  test("isDirectory reflects the packaging passed in", () => {
    fs.writeFileSync(path.join(srcDir, "single-file.txt"), "content");
    const directory = new AssetStaging(stack(), "dir", {
      sourcePath: srcDir,
      packaging: AssetPackaging.DIRECTORY,
    });
    const file = new AssetStaging(stack(), "file", {
      sourcePath: path.join(srcDir, "single-file.txt"),
      packaging: AssetPackaging.FILE,
    });
    const zip = new AssetStaging(stack(), "zip", {
      sourcePath: srcDir,
      packaging: AssetPackaging.ZIP,
    });

    expect(directory.isDirectory).toBe(true);
    expect(file.isDirectory).toBe(false);
    expect(zip.isDirectory).toBe(false);
  });

  describe("with a bundler", () => {
    test("SOURCE hashing takes the hash over the source, not the bundler output", () => {
      const withoutBundler = new AssetStaging(stack(), "plain", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
      });
      const withBundler = new AssetStaging(stack(), "bundled", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        // Under SOURCE hashing the build is deferred and never runs here, so
        // bundler output cannot change the hash.
        bundler: {
          bundle: (opts) => {
            fs.writeFileSync(path.join(opts.outputDir, "built.txt"), "output");
            return BundleResult.directory(opts.outputDir);
          },
        },
      });

      expect(withBundler.assetHash).toEqual(withoutBundler.assetHash);
    });

    describe("OUTPUT hashing", () => {
      test("takes the hash over the built output, differing from the source", () => {
        const sourceHashed = new AssetStaging(stack(), "source", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          bundler: {
            bundle: (opts) => {
              fs.writeFileSync(
                path.join(opts.outputDir, "built.txt"),
                "output",
              );
              return BundleResult.directory(opts.outputDir);
            },
          },
        });
        const outputHashed = new AssetStaging(stack(), "output", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          assetHashType: AssetHashType.OUTPUT,
          bundler: {
            bundle: (opts) => {
              fs.writeFileSync(
                path.join(opts.outputDir, "built.txt"),
                "output",
              );
              return BundleResult.directory(opts.outputDir);
            },
          },
        });

        // The output hash reflects the built artifact, which the source hash
        // (over srcDir, which has no built.txt) cannot equal.
        expect(outputHashed.assetHash).not.toEqual(sourceHashed.assetHash);
      });

      test("tracks changes in the built output even when the source is unchanged", () => {
        const buildA = new AssetStaging(stack(), "a", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          assetHashType: AssetHashType.OUTPUT,
          bundler: {
            bundle: (opts) => {
              fs.writeFileSync(path.join(opts.outputDir, "built.txt"), "one");
              return BundleResult.directory(opts.outputDir);
            },
          },
        });
        const buildB = new AssetStaging(stack(), "b", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          assetHashType: AssetHashType.OUTPUT,
          bundler: {
            bundle: (opts) => {
              fs.writeFileSync(path.join(opts.outputDir, "built.txt"), "two");
              return BundleResult.directory(opts.outputDir);
            },
          },
        });

        // Same source, different output bytes -> different identity. This is
        // exactly what SOURCE hashing cannot catch.
        expect(buildA.assetHash).not.toEqual(buildB.assetHash);
      });

      test("builds once: the constructor builds, and stage() reuses that output", () => {
        let buildCount = 0;
        const staging = new AssetStaging(stack(), "staging", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          assetHashType: AssetHashType.OUTPUT,
          bundler: {
            bundle: (opts) => {
              buildCount++;
              fs.writeFileSync(
                path.join(opts.outputDir, "built.txt"),
                "output",
              );
              return BundleResult.directory(opts.outputDir);
            },
          },
        });

        // Built eagerly during construction, before stage().
        expect(buildCount).toBe(1);

        const targetPath = path.join(createTempDir(), "out");
        fs.mkdirSync(targetPath, { recursive: true });
        staging.stage(targetPath);

        // stage() packaged the eager build rather than building again.
        expect(buildCount).toBe(1);
        expect(fs.existsSync(path.join(targetPath, "built.txt"))).toBe(true);
      });

      test("cleans up the eagerly-built scratch directory after stage()", () => {
        let observedOutputDir: string | undefined;
        const staging = new AssetStaging(stack(), "staging", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          assetHashType: AssetHashType.OUTPUT,
          bundler: {
            bundle: (opts) => {
              observedOutputDir = opts.outputDir;
              fs.writeFileSync(
                path.join(opts.outputDir, "built.txt"),
                "output",
              );
              return BundleResult.directory(opts.outputDir);
            },
          },
        });
        const targetPath = path.join(createTempDir(), "out");
        fs.mkdirSync(targetPath, { recursive: true });

        staging.stage(targetPath);

        expect(observedOutputDir).toBeDefined();
        expect(fs.existsSync(observedOutputDir!)).toBe(false);
      });

      test("cleans up the eager-build scratch when the bundler throws in the constructor", () => {
        let observedOutputDir: string | undefined;

        expect(
          () =>
            new AssetStaging(stack(), "staging", {
              sourcePath: srcDir,
              packaging: AssetPackaging.DIRECTORY,
              assetHashType: AssetHashType.OUTPUT,
              bundler: {
                bundle: (opts) => {
                  observedOutputDir = opts.outputDir;
                  throw new Error("build failed");
                },
              },
            }),
        ).toThrow(/build failed/);

        // The eager build failed before eagerBuild was set, so stage() can
        // never reach this scratch; hashOutput must reclaim it immediately.
        expect(observedOutputDir).toBeDefined();
        expect(fs.existsSync(path.dirname(observedOutputDir!))).toBe(false);
      });

      test("sweeps the scratch directory on process exit when stage() never runs", () => {
        // When stage() never runs (an unsynthesized stack), the process-exit
        // hook is the safety net. Run in a child process so a real `exit`
        // fires: the child prints the scratch path, the parent asserts it was
        // swept.
        const marker = path.join(createTempDir(), "scratch-path.txt");
        const script = `
          const fs = require("fs");
          const { AssetStaging, App, BundleResult, TerraformStack } = require(${JSON.stringify(
            path.resolve(__dirname, "../lib"),
          )});
          const stack = new TerraformStack(new App(), "s");
          new AssetStaging(stack, "staging", {
            sourcePath: ${JSON.stringify(srcDir)},
            packaging: require(${JSON.stringify(
              path.resolve(__dirname, "../lib"),
            )}).AssetPackaging.DIRECTORY,
            assetHashType: "output",
            bundler: {
              bundle: (opts) => {
                fs.writeFileSync(${JSON.stringify(marker)}, opts.outputDir);
                fs.writeFileSync(opts.outputDir + "/built.txt", "output");
                return BundleResult.directory(opts.outputDir);
              },
            },
          });
          // Intentionally never call stage().
        `;
        execFileSync(process.execPath, ["-e", script]);

        const scratch = fs.readFileSync(marker, "utf-8");
        expect(scratch).toContain("cdktn-bundle-");
        expect(fs.existsSync(scratch)).toBe(false);
      });
    });

    test("stage() runs the bundler and packages its output, not the source", () => {
      const staging = new AssetStaging(stack(), "staging", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        bundler: {
          bundle: (opts) => {
            expect(opts.source).toBe(srcDir);
            fs.writeFileSync(path.join(opts.outputDir, "built.txt"), "output");
            return BundleResult.directory(opts.outputDir);
          },
        },
      });
      const targetPath = path.join(createTempDir(), "out");
      fs.mkdirSync(targetPath, { recursive: true });

      staging.stage(targetPath);

      // The bundler's output is staged...
      expect(fs.existsSync(path.join(targetPath, "built.txt"))).toBe(true);
      // ...and the original source is not.
      expect(fs.existsSync(path.join(targetPath, "a.txt"))).toBe(false);
    });

    test("exclude filters the source, not the bundler output", () => {
      // `exclude` is source filtering: an install-style bundler produces the
      // very directory a user excludes from source (e.g. node_modules), and
      // re-applying the exclusion to the output would strip built content.
      const staging = new AssetStaging(stack(), "staging", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        exclude: ["node_modules"],
        bundler: {
          bundle: (opts) => {
            const built = path.join(opts.outputDir, "node_modules");
            fs.mkdirSync(built);
            fs.writeFileSync(path.join(built, "dep.js"), "dependency");
            return BundleResult.directory(opts.outputDir);
          },
        },
      });
      const targetPath = path.join(createTempDir(), "out");
      fs.mkdirSync(targetPath, { recursive: true });

      staging.stage(targetPath);

      // The bundler's node_modules survives — it is built output, not source.
      expect(
        fs.existsSync(path.join(targetPath, "node_modules", "dep.js")),
      ).toBe(true);
    });

    test("bundlerKey changes the hash", () => {
      const withoutKey = new AssetStaging(stack(), "without", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        bundler: { bundle: (opts) => BundleResult.directory(opts.outputDir) },
      });
      const withKey = new AssetStaging(stack(), "with", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        bundler: {
          bundlerKey: "docker:node:20:npm run build",
          bundle: (opts) => BundleResult.directory(opts.outputDir),
        },
      });
      const withDifferentKey = new AssetStaging(stack(), "different", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        bundler: {
          bundlerKey: "docker:node:18:npm run build",
          bundle: (opts) => BundleResult.directory(opts.outputDir),
        },
      });

      expect(withKey.assetHash).not.toEqual(withoutKey.assetHash);
      expect(withKey.assetHash).not.toEqual(withDifferentKey.assetHash);
    });

    test("ARCHIVE packaging with a bundler is allowed", () => {
      const staging = new AssetStaging(stack(), "staging", {
        sourcePath: srcDir,
        packaging: AssetPackaging.ZIP,
        bundler: {
          bundle: (opts) => {
            fs.writeFileSync(path.join(opts.outputDir, "built.txt"), "output");
            return BundleResult.directory(opts.outputDir);
          },
        },
      });
      const targetPath = path.join(createTempDir(), "archive.zip");
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      expect(() => staging.stage(targetPath)).not.toThrow();
      expect(fs.existsSync(targetPath)).toBe(true);
    });

    test("a directory-source single-file packaging (e.g. tar.gz) with a bundler is allowed", () => {
      // A tar.gz-style packaging takes a directory source but emits one file;
      // acceptance keys on `acceptsDirectorySource`, so it must not be
      // rejected.
      const tarLike: IAssetPackaging = {
        extension: ".tar.gz",
        producesDirectory: false,
        acceptsDirectorySource: true,
        omitsDirectoryEntries: false,
        pack: (opts) => {
          // Stand-in for a real tar writer; only needs to read a directory
          // source and emit a single file.
          fs.writeFileSync(opts.target, "tarball");
        },
      };

      expect(
        () =>
          new AssetStaging(stack(), "staging", {
            sourcePath: srcDir,
            packaging: tarLike,
            bundler: {
              bundle: (opts) => BundleResult.directory(opts.outputDir),
            },
          }),
      ).not.toThrow();
    });

    test("a bundler may return a subdirectory of outputDir", () => {
      const staging = new AssetStaging(stack(), "staging", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        bundler: {
          bundle: (opts) => {
            const dist = path.join(opts.outputDir, "dist");
            fs.mkdirSync(dist);
            fs.writeFileSync(path.join(dist, "bundle.js"), "built");
            return BundleResult.directory(dist);
          },
        },
      });
      const targetPath = path.join(createTempDir(), "out");
      fs.mkdirSync(targetPath, { recursive: true });

      staging.stage(targetPath);

      // Only the returned subdirectory's contents are staged.
      expect(fs.existsSync(path.join(targetPath, "bundle.js"))).toBe(true);
    });

    test("the scratch directory is cleaned up after a successful bundle", () => {
      let observedOutputDir: string | undefined;
      const staging = new AssetStaging(stack(), "staging", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        bundler: {
          bundle: (opts) => {
            observedOutputDir = opts.outputDir;
            fs.writeFileSync(path.join(opts.outputDir, "built.txt"), "output");
            return BundleResult.directory(opts.outputDir);
          },
        },
      });
      const targetPath = path.join(createTempDir(), "out");
      fs.mkdirSync(targetPath, { recursive: true });

      staging.stage(targetPath);

      expect(observedOutputDir).toBeDefined();
      expect(fs.existsSync(observedOutputDir!)).toBe(false);
    });

    test("a throwing bundler propagates and still cleans up the scratch directory", () => {
      let observedOutputDir: string | undefined;
      const staging = new AssetStaging(stack(), "staging", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        bundler: {
          bundle: (opts) => {
            observedOutputDir = opts.outputDir;
            throw new Error("build failed");
          },
        },
      });
      const targetPath = path.join(createTempDir(), "out");
      fs.mkdirSync(targetPath, { recursive: true });

      expect(() => staging.stage(targetPath)).toThrow(/build failed/);
      expect(observedOutputDir).toBeDefined();
      expect(fs.existsSync(observedOutputDir!)).toBe(false);
    });

    test("the bundler is handed an absolute source path", () => {
      // A relative sourcePath (the common case: TerraformAsset stores one
      // relative to process.cwd()) must still reach the bundler as absolute,
      // since a bundler runs a tool with its own cwd.
      const relativeSource = path.relative(process.cwd(), srcDir);
      let observedSource: string | undefined;
      const staging = new AssetStaging(stack(), "staging", {
        sourcePath: relativeSource,
        packaging: AssetPackaging.DIRECTORY,
        bundler: {
          bundle: (opts) => {
            observedSource = opts.source;
            fs.writeFileSync(path.join(opts.outputDir, "built.txt"), "output");
            return BundleResult.directory(opts.outputDir);
          },
        },
      });
      const targetPath = path.join(createTempDir(), "out");
      fs.mkdirSync(targetPath, { recursive: true });

      staging.stage(targetPath);

      expect(observedSource).toBeDefined();
      expect(path.isAbsolute(observedSource!)).toBe(true);
    });

    test("exclude filters what the bundler reads, and the source is a copy", () => {
      // With exclusions, the bundler must see a filtered copy, not the
      // original tree, so it reads the same file set the hash was taken over.
      let sawExcluded = true;
      let sawIncluded = false;
      let handedSource: string | undefined;
      const staging = new AssetStaging(stack(), "staging", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        exclude: ["*.md"],
        bundler: {
          bundle: (opts) => {
            handedSource = opts.source;
            sawExcluded = fs.existsSync(path.join(opts.source, "b.md"));
            sawIncluded = fs.existsSync(path.join(opts.source, "a.txt"));
            fs.writeFileSync(path.join(opts.outputDir, "built.txt"), "output");
            return BundleResult.directory(opts.outputDir);
          },
        },
      });
      const targetPath = path.join(createTempDir(), "out");
      fs.mkdirSync(targetPath, { recursive: true });

      staging.stage(targetPath);

      expect(sawExcluded).toBe(false);
      expect(sawIncluded).toBe(true);
      // The bundler read a materialised copy, never the original source dir.
      expect(handedSource).not.toEqual(srcDir);
      expect(handedSource).not.toEqual(path.resolve(srcDir));
    });

    test("without exclusions the bundler reads the source directly", () => {
      let handedSource: string | undefined;
      const staging = new AssetStaging(stack(), "staging", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        bundler: {
          bundle: (opts) => {
            handedSource = opts.source;
            fs.writeFileSync(path.join(opts.outputDir, "built.txt"), "output");
            return BundleResult.directory(opts.outputDir);
          },
        },
      });
      const targetPath = path.join(createTempDir(), "out");
      fs.mkdirSync(targetPath, { recursive: true });

      staging.stage(targetPath);

      expect(handedSource).toEqual(path.resolve(srcDir));
    });

    test("a directory result that is actually a file throws", () => {
      const staging = new AssetStaging(stack(), "staging", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        bundler: {
          bundle: (opts) => {
            const file = path.join(opts.outputDir, "artifact.js");
            fs.writeFileSync(file, "built");
            // Declares a directory but points at a file.
            return BundleResult.directory(file);
          },
        },
      });
      const targetPath = path.join(createTempDir(), "out");
      fs.mkdirSync(targetPath, { recursive: true });

      expect(() => staging.stage(targetPath)).toThrow(/not a directory/i);
    });

    test("a directory result at a nonexistent path throws", () => {
      const staging = new AssetStaging(stack(), "staging", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        bundler: {
          bundle: (opts) =>
            BundleResult.directory(path.join(opts.outputDir, "does-not-exist")),
        },
      });
      const targetPath = path.join(createTempDir(), "out");
      fs.mkdirSync(targetPath, { recursive: true });

      expect(() => staging.stage(targetPath)).toThrow(/not a directory/i);
    });

    test("a file result that is actually a directory throws", () => {
      fs.writeFileSync(path.join(srcDir, "single.txt"), "content");
      const staging = new AssetStaging(stack(), "staging", {
        sourcePath: path.join(srcDir, "single.txt"),
        packaging: AssetPackaging.FILE,
        bundler: {
          bundle: (opts) => {
            const dir = path.join(opts.outputDir, "not-a-file");
            fs.mkdirSync(dir);
            // Declares a file but points at a directory.
            return BundleResult.file(dir);
          },
        },
      });
      const targetPath = path.join(createTempDir(), "artifact.txt");
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      expect(() => staging.stage(targetPath)).toThrow(/not a file/i);
    });

    test("a second stage() throws instead of rebuilding (OUTPUT)", () => {
      let buildCount = 0;
      const staging = new AssetStaging(stack(), "staging", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        assetHashType: AssetHashType.OUTPUT,
        bundler: {
          bundle: (opts) => {
            buildCount++;
            fs.writeFileSync(path.join(opts.outputDir, "built.txt"), "output");
            return BundleResult.directory(opts.outputDir);
          },
        },
      });
      const first = path.join(createTempDir(), "out");
      fs.mkdirSync(first, { recursive: true });
      staging.stage(first);

      const second = path.join(createTempDir(), "out");
      fs.mkdirSync(second, { recursive: true });

      // The eager build was consumed by the first stage(); a second would
      // otherwise rebuild and stage bytes not matching the computed hash.
      expect(() => staging.stage(second)).toThrow(/already staged/i);
      expect(buildCount).toBe(1);
    });

    test("a second stage() throws even without a bundler", () => {
      const staging = new AssetStaging(stack(), "staging", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
      });
      const first = path.join(createTempDir(), "out");
      fs.mkdirSync(first, { recursive: true });
      staging.stage(first);

      const second = path.join(createTempDir(), "out");
      fs.mkdirSync(second, { recursive: true });
      expect(() => staging.stage(second)).toThrow(/already staged/i);
    });

    test("errors name the caller's displayName, not the staging child id", () => {
      fs.writeFileSync(path.join(srcDir, "single.txt"), "content");
      // A directory-producing bundler with FILE packaging is a shape mismatch,
      // caught when the build runs. The message must name the caller.
      const staging = new AssetStaging(stack(), "Staging", {
        sourcePath: path.join(srcDir, "single.txt"),
        packaging: AssetPackaging.FILE,
        displayName: "MyAsset",
        bundler: {
          bundle: (opts) => BundleResult.directory(opts.outputDir),
        },
      });
      const targetPath = path.join(createTempDir(), "artifact.txt");
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      expect(() => staging.stage(targetPath)).toThrow(/TerraformAsset MyAsset/);
    });

    describe("output shape (archive-producing bundlers)", () => {
      test("a file-producing bundler stages verbatim with FILE packaging", () => {
        fs.writeFileSync(path.join(srcDir, "single.txt"), "content");
        const staging = new AssetStaging(stack(), "staging", {
          sourcePath: path.join(srcDir, "single.txt"),
          packaging: AssetPackaging.FILE,
          bundler: {
            bundle: (opts) => {
              const archive = path.join(opts.outputDir, "archive.zip");
              fs.writeFileSync(archive, "zip-bytes");
              return BundleResult.file(archive);
            },
          },
        });
        const targetPath = path.join(createTempDir(), "archive.zip");
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });

        staging.stage(targetPath);

        // Staged as the single file the bundler produced — no wrapper
        // directory, no double archive.
        expect(fs.statSync(targetPath).isFile()).toBe(true);
        expect(fs.readFileSync(targetPath, "utf-8")).toBe("zip-bytes");
      });

      test("a file-producing bundler under OUTPUT hashing hashes the file", () => {
        fs.writeFileSync(path.join(srcDir, "single.txt"), "content");
        const one = new AssetStaging(stack(), "one", {
          sourcePath: path.join(srcDir, "single.txt"),
          packaging: AssetPackaging.FILE,
          assetHashType: AssetHashType.OUTPUT,
          bundler: {
            bundle: (opts) => {
              const archive = path.join(opts.outputDir, "archive.zip");
              fs.writeFileSync(archive, "bytes-one");
              return BundleResult.file(archive);
            },
          },
        });
        const two = new AssetStaging(stack(), "two", {
          sourcePath: path.join(srcDir, "single.txt"),
          packaging: AssetPackaging.FILE,
          assetHashType: AssetHashType.OUTPUT,
          bundler: {
            bundle: (opts) => {
              const archive = path.join(opts.outputDir, "archive.zip");
              fs.writeFileSync(archive, "bytes-two");
              return BundleResult.file(archive);
            },
          },
        });

        // Different archive bytes -> different identity.
        expect(one.assetHash).not.toEqual(two.assetHash);
      });

      test("a file-producing bundler with DIRECTORY packaging throws", () => {
        const staging = new AssetStaging(stack(), "staging", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          bundler: {
            bundle: (opts) => {
              const archive = path.join(opts.outputDir, "archive.zip");
              fs.writeFileSync(archive, "zip-bytes");
              return BundleResult.file(archive);
            },
          },
        });
        const targetPath = path.join(createTempDir(), "out");
        fs.mkdirSync(targetPath, { recursive: true });

        expect(() => staging.stage(targetPath)).toThrow(
          /AssetType\.FILE|single-file/i,
        );
      });

      test("a directory-producing bundler with FILE packaging throws", () => {
        fs.writeFileSync(path.join(srcDir, "single.txt"), "content");
        const staging = new AssetStaging(stack(), "staging", {
          sourcePath: path.join(srcDir, "single.txt"),
          packaging: AssetPackaging.FILE,
          bundler: {
            bundle: (opts) => BundleResult.directory(opts.outputDir),
          },
        });
        const targetPath = path.join(createTempDir(), "artifact.txt");
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });

        expect(() => staging.stage(targetPath)).toThrow(
          /AssetType\.DIRECTORY|AssetType\.ARCHIVE|single file/i,
        );
      });
    });

    describe("decline protocol and ChainBundler", () => {
      test("ChainBundler falls through a declining bundler to the next", () => {
        const calls: string[] = [];
        const local = {
          bundlerKey: "local:v1",
          bundle: () => {
            calls.push("local");
            return BundleResult.declined();
          },
        };
        const docker = {
          bundlerKey: "docker:v1",
          bundle: (opts: { outputDir: string; source: string }) => {
            calls.push("docker");
            fs.writeFileSync(path.join(opts.outputDir, "built.txt"), "output");
            return BundleResult.directory(opts.outputDir);
          },
        };
        const staging = new AssetStaging(stack(), "staging", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          bundler: ChainBundler.of(local, docker),
        });
        const targetPath = path.join(createTempDir(), "out");
        fs.mkdirSync(targetPath, { recursive: true });

        staging.stage(targetPath);

        expect(calls).toEqual(["local", "docker"]);
        expect(fs.existsSync(path.join(targetPath, "built.txt"))).toBe(true);
      });

      test("a leg that writes before declining does not leak into the winning leg", () => {
        // A declining leg may still have written to its output directory
        // (esbuild failing partway, a Docker leg creating output before the
        // daemon check). Per-leg isolation must keep that out of the result.
        const writesThenDeclines = {
          bundle: (opts: { outputDir: string; source: string }) => {
            fs.writeFileSync(path.join(opts.outputDir, "sentinel.txt"), "leak");
            return BundleResult.declined();
          },
        };
        const succeeds = {
          bundle: (opts: { outputDir: string; source: string }) => {
            fs.writeFileSync(path.join(opts.outputDir, "built.txt"), "output");
            return BundleResult.directory(opts.outputDir);
          },
        };
        const staging = new AssetStaging(stack(), "staging", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          bundler: ChainBundler.of(writesThenDeclines, succeeds),
        });
        const targetPath = path.join(createTempDir(), "out");
        fs.mkdirSync(targetPath, { recursive: true });

        staging.stage(targetPath);

        expect(fs.existsSync(path.join(targetPath, "built.txt"))).toBe(true);
        expect(fs.existsSync(path.join(targetPath, "sentinel.txt"))).toBe(
          false,
        );
      });

      test("ChainBundler prefers the first bundler that runs", () => {
        const calls: string[] = [];
        const local = {
          bundle: (opts: { outputDir: string; source: string }) => {
            calls.push("local");
            fs.writeFileSync(path.join(opts.outputDir, "built.txt"), "local");
            return BundleResult.directory(opts.outputDir);
          },
        };
        const docker = {
          bundle: () => {
            calls.push("docker");
            return BundleResult.declined();
          },
        };
        const staging = new AssetStaging(stack(), "staging", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          bundler: ChainBundler.of(local, docker),
        });
        const targetPath = path.join(createTempDir(), "out");
        fs.mkdirSync(targetPath, { recursive: true });

        staging.stage(targetPath);

        expect(calls).toEqual(["local"]);
      });

      test("ChainBundler throws when every bundler declines", () => {
        const staging = new AssetStaging(stack(), "staging", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          bundler: ChainBundler.of(
            { bundle: () => BundleResult.declined() },
            { bundle: () => BundleResult.declined() },
          ),
        });
        const targetPath = path.join(createTempDir(), "out");
        fs.mkdirSync(targetPath, { recursive: true });

        expect(() => staging.stage(targetPath)).toThrow(/declined/i);
      });

      test("a bare bundler that declines throws (nothing to fall back to)", () => {
        const staging = new AssetStaging(stack(), "staging", {
          sourcePath: srcDir,
          packaging: AssetPackaging.DIRECTORY,
          bundler: { bundle: () => BundleResult.declined() },
        });
        const targetPath = path.join(createTempDir(), "out");
        fs.mkdirSync(targetPath, { recursive: true });

        expect(() => staging.stage(targetPath)).toThrow();
      });

      test("ChainBundler identity is stable regardless of which leg runs", () => {
        const localKey = "local:v1";
        const dockerKey = "docker:v1";
        // Same legs, but the first declines in one and runs in the other; the
        // chain's bundlerKey folds in both, so identity must match.
        const chainA = ChainBundler.of(
          { bundlerKey: localKey, bundle: () => BundleResult.declined() },
          {
            bundlerKey: dockerKey,
            bundle: (opts: { outputDir: string; source: string }) =>
              BundleResult.directory(opts.outputDir),
          },
        );
        const chainB = ChainBundler.of(
          {
            bundlerKey: localKey,
            bundle: (opts: { outputDir: string; source: string }) =>
              BundleResult.directory(opts.outputDir),
          },
          { bundlerKey: dockerKey, bundle: () => BundleResult.declined() },
        );

        expect(chainA.bundlerKey).toEqual(chainB.bundlerKey);
      });

      test("ChainBundler.of() with no bundlers throws", () => {
        expect(() => ChainBundler.of()).toThrow(/at least one/i);
      });
    });
  });

  test("a custom packaging's own omitsDirectoryEntries decides the hash frame, not identity with AssetPackaging.ZIP", () => {
    const customZip: IAssetPackaging = {
      ...AssetPackaging.ZIP,
      omitsDirectoryEntries: true,
      pack: AssetPackaging.ZIP.pack.bind(AssetPackaging.ZIP),
    };

    const builtinZip = new AssetStaging(stack(), "builtin", {
      sourcePath: srcDir,
      packaging: AssetPackaging.ZIP,
    });
    const custom = new AssetStaging(stack(), "custom", {
      sourcePath: srcDir,
      packaging: customZip,
    });

    expect(custom.assetHash).toEqual(builtinZip.assetHash);
    expect(custom.assetHash).toEqual(
      hashPath(srcDir, { canonical: true, archive: true }),
    );
  });
});
