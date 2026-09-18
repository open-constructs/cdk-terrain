// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AssetHashType,
  AssetPackaging,
  AssetStaging,
  ASSET_HASH_SALT_CONTEXT_KEY,
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
        // Under the default SOURCE hashing, a bundler that produces entirely
        // different bytes must not change the hash — identity is a function
        // of the inputs, and the build is deferred (never runs here).
        bundler: {
          bundle: (opts) => {
            fs.writeFileSync(path.join(opts.outputDir, "built.txt"), "output");
            return opts.outputDir;
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
              return opts.outputDir;
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
              return opts.outputDir;
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
              return opts.outputDir;
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
              return opts.outputDir;
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
              return opts.outputDir;
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
              return opts.outputDir;
            },
          },
        });
        const targetPath = path.join(createTempDir(), "out");
        fs.mkdirSync(targetPath, { recursive: true });

        staging.stage(targetPath);

        expect(observedOutputDir).toBeDefined();
        expect(fs.existsSync(observedOutputDir!)).toBe(false);
      });

      test("sweeps the scratch directory on process exit when stage() never runs", () => {
        // The eager build happens in the constructor but is normally cleaned
        // up in stage(). When stage() never runs (an unsynthesized stack),
        // the process-exit hook is the safety net. Exercised in a child
        // process against the compiled lib so a real `exit` fires; the child
        // prints the scratch path it created, and the parent asserts it was
        // swept.
        const marker = path.join(createTempDir(), "scratch-path.txt");
        const script = `
          const fs = require("fs");
          const { AssetStaging, App, TerraformStack } = require(${JSON.stringify(
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
                return opts.outputDir;
              },
            },
          });
          // Intentionally never call stage().
        `;
        require("child_process").execFileSync(process.execPath, ["-e", script]);

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
            return opts.outputDir;
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
            return opts.outputDir;
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
        bundler: { bundle: (opts) => opts.outputDir },
      });
      const withKey = new AssetStaging(stack(), "with", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        bundler: {
          bundlerKey: "docker:node:20:npm run build",
          bundle: (opts) => opts.outputDir,
        },
      });
      const withDifferentKey = new AssetStaging(stack(), "different", {
        sourcePath: srcDir,
        packaging: AssetPackaging.DIRECTORY,
        bundler: {
          bundlerKey: "docker:node:18:npm run build",
          bundle: (opts) => opts.outputDir,
        },
      });

      expect(withKey.assetHash).not.toEqual(withoutKey.assetHash);
      expect(withKey.assetHash).not.toEqual(withDifferentKey.assetHash);
    });

    test("FILE packaging with a bundler throws", () => {
      fs.writeFileSync(path.join(srcDir, "single.txt"), "content");
      expect(
        () =>
          new AssetStaging(stack(), "staging", {
            sourcePath: path.join(srcDir, "single.txt"),
            packaging: AssetPackaging.FILE,
            bundler: { bundle: (opts) => opts.outputDir },
          }),
      ).toThrow(/file packaging|AssetType\.FILE/i);
    });

    test("ARCHIVE packaging with a bundler is allowed", () => {
      const staging = new AssetStaging(stack(), "staging", {
        sourcePath: srcDir,
        packaging: AssetPackaging.ZIP,
        bundler: {
          bundle: (opts) => {
            fs.writeFileSync(path.join(opts.outputDir, "built.txt"), "output");
            return opts.outputDir;
          },
        },
      });
      const targetPath = path.join(createTempDir(), "archive.zip");
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      expect(() => staging.stage(targetPath)).not.toThrow();
      expect(fs.existsSync(targetPath)).toBe(true);
    });

    test("a directory-source single-file packaging (e.g. tar.gz) with a bundler is allowed", () => {
      // Rejection keys on `acceptsDirectorySource`, not on producing a
      // directory or omitting directory entries. A tar.gz-style packaging
      // takes a directory source, emits one file, and keeps directory
      // entries (omitsDirectoryEntries: false) — it must not be rejected.
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
            bundler: { bundle: (opts) => opts.outputDir },
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
            return dist;
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
            return opts.outputDir;
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
