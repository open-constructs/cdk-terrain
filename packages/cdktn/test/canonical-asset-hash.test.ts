// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
// Acceptance tests for the canonicalAssetHashes feature flag
// (https://github.com/open-constructs/cdk-terrain/issues/322)
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Testing, TerraformStack, TerraformAsset, AssetType } from "../src";
import { CANONICAL_ASSET_HASHES } from "../src/features";
import { hashPath } from "../src/private/fs";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-canonical-test-"));
}

const canonical = (p: string) => hashPath(p, { canonical: true });

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
});
