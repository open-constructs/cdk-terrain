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
