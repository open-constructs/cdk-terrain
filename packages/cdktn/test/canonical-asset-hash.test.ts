// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
// Acceptance tests for the canonicalAssetHashes feature flag
// (https://github.com/open-constructs/cdk-terrain/issues/322)
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Testing,
  TerraformStack,
  TerraformAsset,
  AssetType,
  AssetHash,
  AssetHashType,
  BundleResult,
  IAsset,
} from "../src";
import { CANONICAL_ASSET_HASHES } from "../src/features";
import { TerraformModuleAsset } from "../src/terraform-module-asset";
import { archiveSync, hashPath } from "../src/private/fs";
import { testIfPosixPermissions, testIfSymlinks } from "./helper/capabilities";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-canonical-test-"));
}

const canonical = (p: string) => hashPath(p, { canonical: true });
const canonicalArchive = (p: string) =>
  hashPath(p, { canonical: true, archive: true });

describe("canonical asset hash scheme", () => {
  let srcDir: string;

  beforeEach(() => {
    srcDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  test("renaming a file changes the hash (legacy scheme cannot see renames)", () => {
    fs.writeFileSync(path.join(srcDir, "a.txt"), "content");
    const before = { legacy: hashPath(srcDir), canonical: canonical(srcDir) };

    fs.renameSync(path.join(srcDir, "a.txt"), path.join(srcDir, "b.txt"));

    expect(hashPath(srcDir)).toBe(before.legacy);
    expect(canonical(srcDir)).not.toBe(before.canonical);
  });

  test("shifting bytes across entry boundaries changes the hash", () => {
    fs.writeFileSync(path.join(srcDir, "a.txt"), "x");
    fs.writeFileSync(path.join(srcDir, "b.txt"), "yz");
    const before = canonical(srcDir);

    fs.writeFileSync(path.join(srcDir, "a.txt"), "xy");
    fs.writeFileSync(path.join(srcDir, "b.txt"), "z");

    expect(canonical(srcDir)).not.toBe(before);
  });

  testIfPosixPermissions(
    "changing file permissions changes the hash (archiveSync emits them)",
    () => {
      const file = path.join(srcDir, "run.sh");
      fs.writeFileSync(file, "#!/bin/sh\n");
      fs.chmodSync(file, 0o644);
      const before = canonical(srcDir);

      fs.chmodSync(file, 0o755);

      expect(canonical(srcDir)).not.toBe(before);
    },
  );

  test("adding or removing an empty directory changes the hash (copySync emits them)", () => {
    fs.writeFileSync(path.join(srcDir, "a.txt"), "content");
    const before = canonical(srcDir);

    fs.mkdirSync(path.join(srcDir, "empty"));
    const withDir = canonical(srcDir);
    expect(withDir).not.toBe(before);

    fs.rmdirSync(path.join(srcDir, "empty"));
    expect(canonical(srcDir)).toBe(before);
  });

  testIfSymlinks(
    "a regular file and a symlink with the same payload hash differently",
    () => {
      const asFile = createTempDir();
      fs.writeFileSync(path.join(asFile, "current"), "a.txt");
      const asLink = createTempDir();
      fs.symlinkSync("a.txt", path.join(asLink, "current"));

      expect(canonical(asFile)).not.toBe(canonical(asLink));

      fs.rmSync(asFile, { recursive: true, force: true });
      fs.rmSync(asLink, { recursive: true, force: true });
    },
  );

  testIfSymlinks(
    "does not crash on circular symlinks and sees retargeting",
    () => {
      fs.mkdirSync(path.join(srcDir, "pkg"));
      fs.writeFileSync(path.join(srcDir, "pkg", "index.js"), "module");
      fs.symlinkSync("../pkg", path.join(srcDir, "pkg", "self"));
      const before = canonical(srcDir);

      fs.rmSync(path.join(srcDir, "pkg", "self"));
      fs.symlinkSync("index.js", path.join(srcDir, "pkg", "self"));

      expect(canonical(srcDir)).not.toBe(before);
    },
  );

  testIfSymlinks(
    "identical logical trees hash identically regardless of location",
    () => {
      const build = (root: string) => {
        fs.mkdirSync(path.join(root, "sub"));
        fs.mkdirSync(path.join(root, "empty"));
        const file = path.join(root, "sub", "a.txt");
        fs.writeFileSync(file, "content");
        fs.chmodSync(file, 0o644);
        fs.symlinkSync("sub/a.txt", path.join(root, "link"));
      };
      const otherDir = createTempDir();
      build(srcDir);
      build(otherDir);

      expect(canonical(srcDir)).toBe(canonical(otherDir));
      // repeated runs over the same tree are stable
      expect(canonical(srcDir)).toBe(canonical(srcDir));

      fs.rmSync(otherDir, { recursive: true, force: true });
    },
  );
});

describe("canonical archive hashing tracks the emitted ZIP", () => {
  let srcDir: string;
  let outDir: string;

  const zipBytes = () => {
    const dest = path.join(
      outDir,
      `archive-${fs.readdirSync(outDir).length}.zip`,
    );
    archiveSync(srcDir, dest);
    return fs.readFileSync(dest);
  };

  beforeEach(() => {
    srcDir = createTempDir();
    outDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test("an empty directory changes neither the ZIP bytes nor the archive hash", () => {
    fs.writeFileSync(path.join(srcDir, "a.txt"), "content");
    const before = { zip: zipBytes(), hash: canonicalArchive(srcDir) };
    const beforeDirectoryHash = canonical(srcDir);

    fs.mkdirSync(path.join(srcDir, "empty"));

    expect(zipBytes().equals(before.zip)).toBe(true);
    expect(canonicalArchive(srcDir)).toBe(before.hash);
    // directory assets do materialize the directory, so their hash moves
    expect(canonical(srcDir)).not.toBe(beforeDirectoryHash);
  });

  testIfPosixPermissions(
    "a permission change alters both the ZIP bytes and the archive hash",
    () => {
      const file = path.join(srcDir, "run.sh");
      fs.writeFileSync(file, "#!/bin/sh\n");
      fs.chmodSync(file, 0o644);
      const before = { zip: zipBytes(), hash: canonicalArchive(srcDir) };

      fs.chmodSync(file, 0o755);

      expect(zipBytes().equals(before.zip)).toBe(false);
      expect(canonicalArchive(srcDir)).not.toBe(before.hash);
    },
  );

  test("equivalent trees with different creation histories emit identical archives", () => {
    const build = (root: string, order: string[]) => {
      fs.mkdirSync(path.join(root, "sub"));
      for (const name of order) {
        fs.writeFileSync(path.join(root, "sub", name), `content of ${name}`);
      }
      // perturb enumeration order on filesystems where it tracks history
      fs.writeFileSync(path.join(root, "sub", "tmp"), "gone");
      fs.rmSync(path.join(root, "sub", "tmp"));
    };
    const otherDir = createTempDir();
    build(srcDir, ["a.txt", "b.txt", "c.txt"]);
    build(otherDir, ["c.txt", "a.txt", "b.txt"]);

    const zipOther = path.join(outDir, "other.zip");
    archiveSync(otherDir, zipOther);

    expect(zipBytes().equals(fs.readFileSync(zipOther))).toBe(true);
    expect(canonicalArchive(srcDir)).toBe(canonicalArchive(otherDir));

    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  test("archive bytes do not depend on filesystem enumeration order", () => {
    fs.mkdirSync(path.join(srcDir, "sub"));
    fs.writeFileSync(path.join(srcDir, "a.txt"), "a");
    fs.writeFileSync(path.join(srcDir, "b.txt"), "b");
    fs.writeFileSync(path.join(srcDir, "sub", "c.txt"), "c");
    const before = { zip: zipBytes(), hash: canonicalArchive(srcDir) };

    // simulate a filesystem that enumerates entries in a different order
    const original = fs.readdirSync;
    const spy = jest
      .spyOn(fs, "readdirSync")
      .mockImplementation(((p: any, o: any) =>
        (original.call(fs, p, o) as any[]).slice().reverse()) as any);
    try {
      expect(zipBytes().equals(before.zip)).toBe(true);
      expect(canonicalArchive(srcDir)).toBe(before.hash);
    } finally {
      spy.mockRestore();
    }
  });

  test("files inside non-empty directories stay visible to the archive hash", () => {
    fs.mkdirSync(path.join(srcDir, "sub"));
    fs.writeFileSync(path.join(srcDir, "sub", "a.txt"), "content");
    const before = { zip: zipBytes(), hash: canonicalArchive(srcDir) };

    fs.renameSync(
      path.join(srcDir, "sub", "a.txt"),
      path.join(srcDir, "sub", "b.txt"),
    );

    expect(zipBytes().equals(before.zip)).toBe(false);
    expect(canonicalArchive(srcDir)).not.toBe(before.hash);
  });
});

describe("TerraformAsset with the canonicalAssetHashes flag", () => {
  let srcDir: string;

  beforeEach(() => {
    srcDir = createTempDir();
    fs.writeFileSync(path.join(srcDir, "a.txt"), "content");
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  test("flag selects the hash scheme", () => {
    // Testing.app() enables FUTURE_FLAGS by default; the off-case models an
    // existing project that has not opted in
    const stackOff = new TerraformStack(
      Testing.app({ enableFutureFlags: false }),
      "off",
    );
    const assetOff = new TerraformAsset(stackOff, "asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
    });

    const stackOn = new TerraformStack(
      Testing.app({ context: { [CANONICAL_ASSET_HASHES]: "true" } }),
      "on",
    );
    const assetOn = new TerraformAsset(stackOn, "asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
    });

    expect(assetOff.assetHash).toBe(hashPath(srcDir));
    expect(assetOn.assetHash).toBe(hashPath(srcDir, { canonical: true }));
    expect(assetOff.assetHash).not.toBe(assetOn.assetHash);
  });

  test("ARCHIVE assets use archive framing (no directory records)", () => {
    fs.mkdirSync(path.join(srcDir, "empty"));
    const stack = new TerraformStack(
      Testing.app({ context: { [CANONICAL_ASSET_HASHES]: "true" } }),
      "on",
    );
    const asset = new TerraformAsset(stack, "asset", {
      path: srcDir,
      type: AssetType.ARCHIVE,
    });

    expect(asset.assetHash).toBe(canonicalArchive(srcDir));
    expect(asset.assetHash).not.toBe(canonical(srcDir));
  });

  // AssetHash.of is packaging-independent; TerraformAsset framing depends on
  // type. The subdirectory makes DIRECTORY and ARCHIVE framing diverge, since
  // ARCHIVE omits directory records.
  describe("AssetHash.of relationship to TerraformAsset", () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(srcDir, "sub"));
      fs.writeFileSync(path.join(srcDir, "sub", "b.txt"), "nested");
    });

    test("equals a DIRECTORY asset hash when the canonical flag is on", () => {
      const stack = new TerraformStack(
        Testing.app({ context: { [CANONICAL_ASSET_HASHES]: "true" } }),
        "on",
      );
      const asset = new TerraformAsset(stack, "asset", {
        path: srcDir,
        type: AssetType.DIRECTORY,
      });

      expect(AssetHash.of(srcDir)).toBe(asset.assetHash);
    });

    test("does not equal an ARCHIVE asset hash (archive omits directory records)", () => {
      const stack = new TerraformStack(
        Testing.app({ context: { [CANONICAL_ASSET_HASHES]: "true" } }),
        "on",
      );
      const asset = new TerraformAsset(stack, "asset", {
        path: srcDir,
        type: AssetType.ARCHIVE,
      });

      expect(AssetHash.of(srcDir)).not.toBe(asset.assetHash);
    });

    test("does not equal a DIRECTORY asset hash on the legacy scheme", () => {
      // AssetHash.of is always canonical; a project that has not opted into
      // the flag hashes its TerraformAsset the legacy way, so the two differ.
      const stack = new TerraformStack(
        Testing.app({ enableFutureFlags: false }),
        "off",
      );
      const asset = new TerraformAsset(stack, "asset", {
        path: srcDir,
        type: AssetType.DIRECTORY,
      });

      expect(AssetHash.of(srcDir)).not.toBe(asset.assetHash);
    });
  });
});

describe("TerraformAsset assetHashType", () => {
  let srcDir: string;

  beforeEach(() => {
    srcDir = createTempDir();
    fs.writeFileSync(path.join(srcDir, "a.txt"), "content");
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  const stack = () =>
    new TerraformStack(
      Testing.app({ context: { [CANONICAL_ASSET_HASHES]: "true" } }),
      "s",
    );

  test("implements IAsset", () => {
    const asset: IAsset = new TerraformAsset(stack(), "asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
    });

    expect(typeof asset.assetHash).toBe("string");
  });

  test("SOURCE (the default) hashes the source", () => {
    const asset = new TerraformAsset(stack(), "asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      assetHashType: AssetHashType.SOURCE,
    });

    expect(asset.assetHash).toBe(hashPath(srcDir, { canonical: true }));
  });

  test("CUSTOM uses the provided assetHash verbatim", () => {
    const asset = new TerraformAsset(stack(), "asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      assetHash: "my-custom-hash",
      assetHashType: AssetHashType.CUSTOM,
    });

    expect(asset.assetHash).toBe("my-custom-hash");
  });

  test("an explicit assetHash implies CUSTOM without stating the type", () => {
    const asset = new TerraformAsset(stack(), "asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      assetHash: "my-custom-hash",
    });

    expect(asset.assetHash).toBe("my-custom-hash");
  });

  test("CUSTOM without an assetHash throws", () => {
    expect(
      () =>
        new TerraformAsset(stack(), "asset", {
          path: srcDir,
          type: AssetType.DIRECTORY,
          assetHashType: AssetHashType.CUSTOM,
        }),
    ).toThrow(/CUSTOM.*assetHash|assetHash/i);
  });

  test("an assetHash with a non-CUSTOM type throws", () => {
    expect(
      () =>
        new TerraformAsset(stack(), "asset", {
          path: srcDir,
          type: AssetType.DIRECTORY,
          assetHash: "my-custom-hash",
          assetHashType: AssetHashType.SOURCE,
        }),
    ).toThrow(/assetHashType.*CUSTOM|CUSTOM/i);
  });

  test("OUTPUT hashes the source, same as SOURCE, until bundling exists", () => {
    const output = new TerraformAsset(stack(), "asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      assetHashType: AssetHashType.OUTPUT,
    });
    const source = new TerraformAsset(stack(), "asset2", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      assetHashType: AssetHashType.SOURCE,
    });

    expect(output.assetHash).toEqual(source.assetHash);
  });

  test("an out-of-range hash type throws instead of returning undefined", () => {
    // Models a value another jsii language could pass that TypeScript's type
    // system would reject; the switch's default guards it at runtime.
    expect(
      () =>
        new TerraformAsset(stack(), "asset", {
          path: srcDir,
          type: AssetType.DIRECTORY,
          assetHashType: "bogus" as unknown as AssetHashType,
        }),
    ).toThrow(/unknown assetHashType/i);
  });

  test("a resolved assetHash with unsafe characters throws, even with no exclude/extraHash set", () => {
    // An assetHash is a path segment in `TerraformAsset.path`, so an unsafe
    // one could escape the assets directory at synth; the check must apply
    // even with no exclude/extraHash set.
    expect(
      () =>
        new TerraformAsset(stack(), "asset", {
          path: srcDir,
          type: AssetType.DIRECTORY,
          assetHash: "../../escape",
          assetHashType: AssetHashType.CUSTOM,
        }),
    ).toThrow(/may only contain/);
  });
});

describe("TerraformAsset with exclude/extraHash (AssetStaging integration)", () => {
  let srcDir: string;

  beforeEach(() => {
    srcDir = createTempDir();
    fs.writeFileSync(path.join(srcDir, "a.txt"), "content");
    fs.writeFileSync(path.join(srcDir, "b.md"), "docs");
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  const stack = () =>
    new TerraformStack(
      Testing.app({ context: { [CANONICAL_ASSET_HASHES]: "true" } }),
      "s",
    );

  test("exclude changes the hash relative to the unexcluded asset", () => {
    const plain = new TerraformAsset(stack(), "asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
    });
    const excluded = new TerraformAsset(stack(), "asset2", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      exclude: ["*.md"],
    });

    expect(excluded.assetHash).not.toEqual(plain.assetHash);
  });

  test("exclude does not change the packaging (a directory stays a directory)", () => {
    const asset = new TerraformAsset(stack(), "asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      exclude: ["*.md"],
    });

    expect(asset.type).toBe(AssetType.DIRECTORY);
    expect(asset.path.endsWith(asset.assetHash)).toBe(true);
  });

  test("excluded files are absent from the staged/packed output", () => {
    const s = stack();
    const asset = new TerraformAsset(s, "asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      exclude: ["*.md"],
    });
    const outdir = Testing.fullSynth(s);
    const stagedDir = path.join(outdir, "stacks", s.node.id, asset.path);

    expect(fs.existsSync(path.join(stagedDir, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(stagedDir, "b.md"))).toBe(false);
  });

  test("extraHash changes the hash", () => {
    const withoutExtra = new TerraformAsset(stack(), "asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
    });
    const withExtra = new TerraformAsset(stack(), "asset2", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      extraHash: "v2",
    });

    expect(withExtra.assetHash).not.toEqual(withoutExtra.assetHash);
  });

  test("an explicit assetHash is used verbatim even with exclude set", () => {
    const asset = new TerraformAsset(stack(), "asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      assetHash: "my-custom-hash",
      exclude: ["*.md"],
    });

    expect(asset.assetHash).toBe("my-custom-hash");
  });

  test("ignoreStrategy negation is honored by hashing and staged/packed output", () => {
    // A plain `relativePath === "b.md"` exclusion is expressible with
    // `exclude` already; the point of `ignoreStrategy` is `!`-negation,
    // which only takes effect with `pruneExcludedDirectories: false` (see
    // `IIgnoreStrategy.pruneExcludedDirectories`) -- without it the excluded
    // directory is pruned and the re-include is never evaluated.
    fs.mkdirSync(path.join(srcDir, "node_modules"));
    fs.writeFileSync(path.join(srcDir, "node_modules", "junk.js"), "junk");
    fs.writeFileSync(path.join(srcDir, "node_modules", "keep.js"), "keep");

    const s = stack();
    const asset = new TerraformAsset(s, "asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      ignoreStrategy: {
        pruneExcludedDirectories: false,
        ignores: ({ relativePath }) =>
          (relativePath === "node_modules" ||
            relativePath.startsWith("node_modules/")) &&
          relativePath !== "node_modules/keep.js",
      },
    });
    // Otherwise identical, but without the `keep.js` re-include: excludes
    // all of `node_modules`. If the hash didn't actually account for
    // `keep.js`, this would collide with `asset`'s hash.
    const withoutReinclude = new TerraformAsset(s, "asset2", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      ignoreStrategy: {
        pruneExcludedDirectories: false,
        ignores: ({ relativePath }) =>
          relativePath === "node_modules" ||
          relativePath.startsWith("node_modules/"),
      },
    });

    expect(asset.assetHash).not.toEqual(withoutReinclude.assetHash);

    const outdir = Testing.fullSynth(s);
    const stagedDir = path.join(outdir, "stacks", s.node.id, asset.path);
    expect(fs.existsSync(path.join(stagedDir, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(stagedDir, "b.md"))).toBe(true);
    expect(fs.existsSync(path.join(stagedDir, "node_modules", "junk.js"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(stagedDir, "node_modules", "keep.js"))).toBe(
      true,
    );
  });

  test("exclude and ignoreStrategy cannot be combined", () => {
    let error: Error | undefined;
    try {
      new TerraformAsset(stack(), "asset", {
        path: srcDir,
        type: AssetType.DIRECTORY,
        exclude: ["*.md"],
        ignoreStrategy: { ignores: () => false },
      });
    } catch (e) {
      error = e as Error;
    }

    // Names the TerraformAsset, not `AssetHash.of()`, which this path never
    // calls into.
    expect(error?.message).toMatch(
      /TerraformAsset.*asset.*exclude.*ignoreStrategy/is,
    );
    expect(error?.message).not.toContain("AssetHash.of()");
  });
});

describe("TerraformAsset artifact layout derives from the packaging", () => {
  let srcDir: string;
  let srcFile: string;

  beforeEach(() => {
    srcDir = createTempDir();
    fs.writeFileSync(path.join(srcDir, "a.txt"), "content");
    srcFile = path.join(srcDir, "a.txt");
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  const stack = () =>
    new TerraformStack(
      Testing.app({ context: { [CANONICAL_ASSET_HASHES]: "true" } }),
      "s",
    );

  test("DIRECTORY has no file segment (producesDirectory)", () => {
    const asset = new TerraformAsset(stack(), "asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
    });

    // The path ends at the hash directory, with nothing appended.
    expect(asset.path.endsWith(asset.assetHash)).toBe(true);
  });

  test("FILE keeps the source filename (no extension packaging)", () => {
    const asset = new TerraformAsset(stack(), "asset", {
      path: srcFile,
      type: AssetType.FILE,
    });

    expect(asset.fileName).toBe("a.txt");
    expect(asset.path.endsWith("/a.txt")).toBe(true);
  });

  test("ARCHIVE names the artifact from the packaging extension", () => {
    const asset = new TerraformAsset(stack(), "asset", {
      path: srcDir,
      type: AssetType.ARCHIVE,
    });

    // ZipPackaging.extension is ".zip", so the artifact is archive.zip -
    // unchanged from before, but now derived rather than hardcoded.
    expect(asset.fileName).toBe("archive.zip");
    expect(asset.path.endsWith("/archive.zip")).toBe(true);
  });

  test("a directory source with a file-producing bundler is accepted", () => {
    // With a bundler in play, the source shape no longer has to match the
    // type, so construction does not reject a directory source with FILE.
    expect(
      () =>
        new TerraformAsset(stack(), "asset", {
          path: srcDir,
          type: AssetType.FILE,
          bundler: {
            bundle: (opts) => {
              const archive = path.join(opts.outputDir, "archive.zip");
              fs.writeFileSync(archive, "zip-bytes");
              return BundleResult.file(archive);
            },
          },
        }),
    ).not.toThrow();
  });

  test("a file-producing bundler names the artifact from outputFileName", () => {
    const s = stack();
    const asset = new TerraformAsset(s, "asset", {
      path: srcDir,
      type: AssetType.FILE,
      bundler: {
        outputFileName: "archive.zip",
        bundle: (opts) => {
          // The runtime name differs from the declared one; the staged name
          // comes from outputFileName, not this temp path.
          const built = path.join(opts.outputDir, "build-output-xyz.zip");
          fs.writeFileSync(built, "zip-bytes");
          return BundleResult.file(built);
        },
      },
    });

    expect(asset.fileName).toBe("archive.zip");
    expect(asset.path.endsWith("/archive.zip")).toBe(true);

    const outdir = Testing.fullSynth(s);
    const stagedFile = path.join(outdir, "stacks", s.node.id, asset.path);
    expect(fs.existsSync(stagedFile)).toBe(true);
    expect(fs.readFileSync(stagedFile, "utf-8")).toBe("zip-bytes");
  });

  test("a file-producing bundler without outputFileName falls back to the source basename", () => {
    const asset = new TerraformAsset(stack(), "asset", {
      path: srcFile,
      type: AssetType.FILE,
      bundler: {
        bundle: (opts) => {
          const built = path.join(opts.outputDir, "whatever.bin");
          fs.writeFileSync(built, "bytes");
          return BundleResult.file(built);
        },
      },
    });

    // No outputFileName: the source basename ("a.txt") is used as before.
    expect(asset.fileName).toBe("a.txt");
  });

  // outputFileName becomes a path segment under the asset's hash directory, so
  // an unsafe value could escape the stack dir or overwrite the just-cleaned
  // named folder. A buggy bundler is the realistic source, not an attacker.
  test.each([
    ["a traversal segment", "../../../../outside-stack.bin"],
    ["a bare parent ref", ".."],
    ["a current-dir ref", "."],
    ["an empty name", ""],
    ["a posix-absolute path", "/etc/evil.bin"],
    ["a nested path", "nested/archive.zip"],
    ["a windows path", "C:\\evil.bin"],
    ["a backslash segment", "..\\..\\evil.bin"],
  ])("outputFileName rejects %s", (_label, outputFileName) => {
    expect(
      () =>
        new TerraformAsset(stack(), "asset", {
          path: srcFile,
          type: AssetType.FILE,
          bundler: {
            outputFileName,
            bundle: (opts) => {
              const built = path.join(opts.outputDir, "built.bin");
              fs.writeFileSync(built, "bytes");
              return BundleResult.file(built);
            },
          },
        }),
    ).toThrow(/invalid outputFileName/i);
  });

  test("outputFileName accepts a plain file name with dots", () => {
    expect(
      () =>
        new TerraformAsset(stack(), "asset", {
          path: srcFile,
          type: AssetType.FILE,
          bundler: {
            outputFileName: "archive.tar.gz",
            bundle: (opts) => {
              const built = path.join(opts.outputDir, "built.bin");
              fs.writeFileSync(built, "bytes");
              return BundleResult.file(built);
            },
          },
        }),
    ).not.toThrow();
  });

  test("a bundler declaring outputFileName with non-FILE packaging is rejected at construction", () => {
    // outputFileName announces FILE output statically, so the mismatch is
    // caught before the (possibly slow) build runs, not inside stage().
    expect(
      () =>
        new TerraformAsset(stack(), "asset", {
          path: srcDir,
          type: AssetType.DIRECTORY,
          bundler: {
            outputFileName: "archive.zip",
            bundle: (opts) => BundleResult.directory(opts.outputDir),
          },
        }),
    ).toThrow(/AssetType\.FILE|single-file/i);
  });

  test("a directory-producing bundler with FILE packaging is rejected", () => {
    // OUTPUT hashing builds eagerly in the constructor, so the shape mismatch
    // (directory output, single-file packaging) surfaces there.
    expect(
      () =>
        new TerraformAsset(stack(), "asset", {
          path: srcDir,
          type: AssetType.FILE,
          assetHashType: AssetHashType.OUTPUT,
          bundler: {
            bundle: (opts) => BundleResult.directory(opts.outputDir),
          },
        }),
    ).toThrow(/AssetType\.DIRECTORY|AssetType\.ARCHIVE|single file/i);
  });

  // Regression: `filteredSource` materialised exclusions by `copySync`-ing
  // the source into a scratch dir, which assumes a directory root and threw
  // ENOTDIR against a file source. Hashing already special-cases a file
  // root (there is nothing under it to filter); staging needs to agree, so
  // a bundler for a file source still gets handed the file itself.
  test.each([
    // `hasExclusions` is true for any defined `ignoreStrategy`, unlike
    // `exclude`, which only triggers it with at least one entry -- both
    // reach `filteredSource` and must be covered.
    ["a no-op ignoreStrategy", { ignoreStrategy: { ignores: () => false } }],
    ["a non-empty exclude", { exclude: ["x"] }],
  ])(
    "a file source with %s and a bundler stages without crashing",
    (_label, extra) => {
      const s = stack();
      const asset = new TerraformAsset(s, "asset", {
        path: srcFile,
        type: AssetType.FILE,
        ...extra,
        bundler: {
          bundle: (opts) => {
            const built = path.join(opts.outputDir, "built.bin");
            fs.writeFileSync(built, "bundled");
            return BundleResult.file(built);
          },
        },
      });

      const outdir = Testing.fullSynth(s);
      const stagedFile = path.join(outdir, "stacks", s.node.id, asset.path);
      expect(fs.readFileSync(stagedFile, "utf-8")).toBe("bundled");
    },
  );
});

describe("TerraformAsset stages inside the stack's own directory (#380)", () => {
  let srcDir: string;

  beforeEach(() => {
    srcDir = createTempDir();
    fs.writeFileSync(path.join(srcDir, "a.txt"), "content");
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  const stack = () =>
    new TerraformStack(
      Testing.app({ context: { [CANONICAL_ASSET_HASHES]: "true" } }),
      "s",
    );

  test("staged asset is reachable under stacks/<id>, not as a sibling of stacks/", () => {
    const s = stack();
    const asset = new TerraformAsset(s, "asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
    });

    const outdir = Testing.fullSynth(s);
    const stackDir = path.join(outdir, "stacks", s.node.id);

    // The asset resolves inside the stack's own directory...
    expect(fs.existsSync(path.join(stackDir, asset.path))).toBe(true);
    // ...never as a sibling of stacks/ (the historical #380 concern).
    expect(fs.existsSync(path.join(outdir, asset.path))).toBe(false);
  });
});

describe("TerraformModuleAsset with the canonicalAssetHashes flag", () => {
  let rootDir: string;
  let moduleA: string;
  let moduleB: string;

  beforeEach(() => {
    // two module sources under a common ancestor that also holds an
    // unrelated sibling file the emitted asset never contains
    rootDir = createTempDir();
    fs.mkdirSync(path.join(rootDir, "a"));
    fs.mkdirSync(path.join(rootDir, "b"));
    fs.writeFileSync(path.join(rootDir, "a", "main.tf"), "module a");
    fs.writeFileSync(path.join(rootDir, "b", "main.tf"), "module b");
    fs.writeFileSync(path.join(rootDir, "unrelated.txt"), "sibling");
    moduleA = path.relative(process.cwd(), path.join(rootDir, "a"));
    moduleB = path.relative(process.cwd(), path.join(rootDir, "b"));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const moduleAssetPath = (canonicalFlag: boolean) => {
    const app = canonicalFlag
      ? Testing.app({
          context: {
            cdktfRelativeModules: [moduleA, moduleB],
            [CANONICAL_ASSET_HASHES]: "true",
          },
        })
      : Testing.app({
          enableFutureFlags: false,
          context: { cdktfRelativeModules: [moduleA, moduleB] },
        });
    const stack = new TerraformStack(app, "stack");
    const asset = new TerraformModuleAsset(stack, "module-asset");
    return asset.getAssetPathForModule(moduleA);
  };

  test("unrelated siblings under the common ancestor do not change the hash", () => {
    const before = moduleAssetPath(true);

    fs.writeFileSync(path.join(rootDir, "unrelated.txt"), "changed");
    fs.mkdirSync(path.join(rootDir, "empty-sibling"));

    expect(moduleAssetPath(true)).toBe(before);

    // while changes to a selected module source still move the hash
    fs.writeFileSync(path.join(rootDir, "a", "main.tf"), "module a changed");
    expect(moduleAssetPath(true)).not.toBe(before);
  });

  test("legacy scheme keeps hashing the common ancestor for compatibility", () => {
    const before = moduleAssetPath(false);

    fs.writeFileSync(path.join(rootDir, "unrelated.txt"), "changed");

    expect(moduleAssetPath(false)).not.toBe(before);
  });
});
