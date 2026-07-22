// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
// Acceptance tests for the canonicalAssetHashes feature flag
// (https://github.com/open-constructs/cdk-terrain/issues/322)
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Testing, TerraformStack, TerraformAsset, AssetType } from "../src";
import { CANONICAL_ASSET_HASHES } from "../src/features";
import { TerraformModuleAsset } from "../src/terraform-module-asset";
import { archiveSync, hashPath } from "../src/private/fs";

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

  test("changing file permissions changes the hash (archiveSync emits them)", () => {
    const file = path.join(srcDir, "run.sh");
    fs.writeFileSync(file, "#!/bin/sh\n");
    fs.chmodSync(file, 0o644);
    const before = canonical(srcDir);

    fs.chmodSync(file, 0o755);

    expect(canonical(srcDir)).not.toBe(before);
  });

  test("adding or removing an empty directory changes the hash (copySync emits them)", () => {
    fs.writeFileSync(path.join(srcDir, "a.txt"), "content");
    const before = canonical(srcDir);

    fs.mkdirSync(path.join(srcDir, "empty"));
    const withDir = canonical(srcDir);
    expect(withDir).not.toBe(before);

    fs.rmdirSync(path.join(srcDir, "empty"));
    expect(canonical(srcDir)).toBe(before);
  });

  test("a regular file and a symlink with the same payload hash differently", () => {
    const asFile = createTempDir();
    fs.writeFileSync(path.join(asFile, "current"), "a.txt");
    const asLink = createTempDir();
    fs.symlinkSync("a.txt", path.join(asLink, "current"));

    expect(canonical(asFile)).not.toBe(canonical(asLink));

    fs.rmSync(asFile, { recursive: true, force: true });
    fs.rmSync(asLink, { recursive: true, force: true });
  });

  test("does not crash on circular symlinks and sees retargeting", () => {
    fs.mkdirSync(path.join(srcDir, "pkg"));
    fs.writeFileSync(path.join(srcDir, "pkg", "index.js"), "module");
    fs.symlinkSync("../pkg", path.join(srcDir, "pkg", "self"));
    const before = canonical(srcDir);

    fs.rmSync(path.join(srcDir, "pkg", "self"));
    fs.symlinkSync("index.js", path.join(srcDir, "pkg", "self"));

    expect(canonical(srcDir)).not.toBe(before);
  });

  test("identical logical trees hash identically regardless of location", () => {
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
  });
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

  test("a permission change alters both the ZIP bytes and the archive hash", () => {
    const file = path.join(srcDir, "run.sh");
    fs.writeFileSync(file, "#!/bin/sh\n");
    fs.chmodSync(file, 0o644);
    const before = { zip: zipBytes(), hash: canonicalArchive(srcDir) };

    fs.chmodSync(file, 0o755);

    expect(zipBytes().equals(before.zip)).toBe(false);
    expect(canonicalArchive(srcDir)).not.toBe(before.hash);
  });

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
