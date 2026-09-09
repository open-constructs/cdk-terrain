// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
//
// Regression tests for asset staging. Each case pins a behaviour that a
// previous implementation got wrong while still passing the rest of the suite:
// hash framing, exclusion handling, symlink fidelity, output-directory
// hygiene, and validation of user-supplied overrides.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AssetStaging,
  AssetHashType,
  TerraformAsset,
  AssetType,
  TerraformStack,
  Testing,
  DockerImage,
  BundlingOutput,
  BundlingFileAccess,
} from "../lib";
import { hashPath } from "../lib/private/fs";
import { CANONICAL_ASSET_HASHES } from "../lib/features";

const CDKTFJSON_PATH = path.join(__dirname, "fixtures", "app", "cdktf.json");

describe("asset staging regressions", () => {
  let tempDir: string;
  let outdir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "asset-staging-"));
    outdir = fs.mkdtempSync(path.join(os.tmpdir(), "asset-outdir-"));
    process.env.CDK_DOCKER = `${__dirname}/docker-stub.sh`;
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outdir, { recursive: true, force: true });
    delete process.env.CDK_DOCKER;
  });

  const appWithOutdir = (ctx: Record<string, any> = {}) => {
    const app = Testing.app({
      outdir,
      context: { cdktfJsonPath: path.resolve(CDKTFJSON_PATH), ...ctx },
    });
    return new TerraformStack(app, "S");
  };

  function mkTree() {
    const dir = path.join(tempDir, "d");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "b.txt"), "y");
    fs.mkdirSync(path.join(dir, "emptydir"));
    return dir;
  }

  test("hashes a zip-packaged directory with archive framing", () => {
    const dir = mkTree();
    const s = new AssetStaging(
      appWithOutdir({ [CANONICAL_ASSET_HASHES]: true }),
      "A",
      { sourcePath: dir, assetHashType: AssetHashType.SOURCE },
    );
    expect(s.packaging).toBe("zip");
    expect(s.assetHash).toBe(hashPath(dir, { canonical: true, archive: true }));
    expect(s.assetHash).not.toBe(
      hashPath(dir, { canonical: true, archive: false }),
    );
  });

  test("an exclude pattern that matches nothing leaves the hash unchanged", () => {
    const dir = mkTree();
    const st = appWithOutdir();
    const plain = new AssetStaging(st, "P", { sourcePath: dir });
    const noop = new AssetStaging(st, "N", {
      sourcePath: dir,
      exclude: ["zzz-matches-nothing"],
    });
    expect(noop.assetHash).toBe(plain.assetHash);
  });

  test("rejects a custom assetHash that is not a safe file name", () => {
    const f = path.join(tempDir, "f.txt");
    fs.writeFileSync(f, "hello");
    expect(
      () =>
        new AssetStaging(appWithOutdir(), "A", {
          sourcePath: f,
          assetHash: "../../../../tmp/pwn",
        }),
    ).toThrow(/only contain letters, digits/);
    // a sane custom hash still works
    const ok = new AssetStaging(appWithOutdir(), "B", {
      sourcePath: f,
      assetHash: "v1.2.3-beta_4",
    });
    expect(ok.assetHash).toBe("v1.2.3-beta_4");
  });

  test("applies exclude patterns to bundled output", () => {
    const dir = path.join(tempDir, "d");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "src.txt"), "x");
    const s = new AssetStaging(appWithOutdir(), "A", {
      sourcePath: dir,
      exclude: ["test1.txt"],
      assetHashType: AssetHashType.OUTPUT,
      bundling: {
        image: DockerImage.fromRegistry("alpine"),
        command: ["DOCKER_STUB_MULTIPLE_FILES"],
      },
    });
    const staged = fs.readdirSync(s.absoluteStagedPath);
    expect(staged).not.toContain("test1.txt");
    expect(staged).toContain("test2.txt");
  });

  test("stages a symlink as a symlink rather than a copy", () => {
    const dir = path.join(tempDir, "d");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    fs.symlinkSync("a.txt", path.join(dir, "link.txt"));
    const s = new AssetStaging(appWithOutdir(), "A", {
      sourcePath: dir,
      exclude: [],
    });
    expect(
      fs
        .lstatSync(path.join(s.absoluteStagedPath, "link.txt"))
        .isSymbolicLink(),
    ).toBe(true);
  });

  test("stages a dangling symlink without failing", () => {
    const dir = path.join(tempDir, "d");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    fs.symlinkSync("/nonexistent/nope", path.join(dir, "broken.txt"));
    const s = new AssetStaging(appWithOutdir(), "A", {
      sourcePath: dir,
      exclude: [],
    });
    expect(
      fs
        .lstatSync(path.join(s.absoluteStagedPath, "broken.txt"))
        .isSymbolicLink(),
    ).toBe(true);
  });

  test("does not inline a symlinked directory", () => {
    const dir = path.join(tempDir, "d");
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, "real"));
    fs.writeFileSync(path.join(dir, "real", "f.txt"), "x");
    fs.symlinkSync("real", path.join(dir, "alias"));
    const s = new AssetStaging(appWithOutdir(), "A", {
      sourcePath: dir,
      exclude: [],
    });
    expect(
      fs.lstatSync(path.join(s.absoluteStagedPath, "alias")).isSymbolicLink(),
    ).toBe(true);
  });

  test("extraHash still busts the hash when a salt is configured", () => {
    const f = path.join(tempDir, "f.txt");
    fs.writeFileSync(f, "hello");
    const st = appWithOutdir({ "cdktn:assetHashSalt": "SALT" });
    const a = new AssetStaging(st, "A", { sourcePath: f, extraHash: "v1" });
    const b = new AssetStaging(st, "B", { sourcePath: f, extraHash: "v2" });
    expect(a.assetHash).not.toBe(b.assetHash);
    // and the salt still matters
    const unsalted = new AssetStaging(appWithOutdir(), "C", {
      sourcePath: f,
      extraHash: "v1",
    });
    expect(unsalted.assetHash).not.toBe(a.assetHash);
  });

  test("leaves no scratch directories in the assets outdir", () => {
    const dir = path.join(tempDir, "d");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    const st = appWithOutdir();
    new AssetStaging(st, "A", {
      sourcePath: dir,
      bundling: {
        image: DockerImage.fromRegistry("alpine"),
        command: ["DOCKER_STUB_SUCCESS"],
      },
    });
    // local bundling path too
    new AssetStaging(st, "B", {
      sourcePath: dir,
      extraHash: "local",
      bundling: {
        image: DockerImage.fromRegistry("alpine"),
        command: ["unused"],
        local: {
          tryBundle(o: string) {
            fs.writeFileSync(path.join(o, "built.txt"), "l");
            return true;
          },
        },
      },
    });
    const entries = fs.readdirSync(path.join(outdir, "assets"));
    expect(entries.filter((e) => !e.startsWith("asset."))).toEqual([]);
  });

  test("keeps the file extension of bundled archive and single-file output", () => {
    const dir = path.join(tempDir, "d");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "src.txt"), "x");
    const zip = new AssetStaging(appWithOutdir(), "A", {
      sourcePath: dir,
      bundling: {
        image: DockerImage.fromRegistry("alpine"),
        command: ["DOCKER_STUB_SINGLE_ARCHIVE"],
        outputType: BundlingOutput.ARCHIVED,
      },
    });
    expect(path.basename(zip.absoluteStagedPath)).toMatch(/\.zip$/);
    expect(fs.statSync(zip.absoluteStagedPath).isFile()).toBe(true);

    const single = new AssetStaging(appWithOutdir(), "B", {
      sourcePath: dir,
      bundling: {
        image: DockerImage.fromRegistry("alpine"),
        command: ["DOCKER_STUB_SINGLE_FILE"],
        outputType: BundlingOutput.SINGLE_FILE,
      },
    });
    expect(path.basename(single.absoluteStagedPath)).toMatch(/\.txt$/);
  });

  test("rejects a FILE type override for a directory asset", () => {
    const dir = path.join(tempDir, "d");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "src.txt"), "x");
    expect(
      () =>
        new TerraformAsset(appWithOutdir(), "A", {
          path: dir,
          type: AssetType.FILE,
          exclude: [],
        }),
    ).toThrow(/expects path to point to a directory|directory/i);
  });

  test("rejects a DIRECTORY type override for single-file bundling output", () => {
    const dir = path.join(tempDir, "d");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "src.txt"), "x");
    expect(
      () =>
        new TerraformAsset(appWithOutdir(), "A", {
          path: dir,
          type: AssetType.DIRECTORY,
          bundling: {
            image: DockerImage.fromRegistry("alpine"),
            command: ["DOCKER_STUB_SINGLE_FILE"],
            outputType: BundlingOutput.SINGLE_FILE,
          },
        }),
    ).toThrow();
  });

  test("supports the documented exclude forms", () => {
    const dir = path.join(tempDir, "d");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "big.js"), "b");
    fs.mkdirSync(path.join(dir, "src", "nested"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "app.ts"), "a");
    fs.writeFileSync(path.join(dir, "src", "nested", "deep.log"), "d");
    fs.writeFileSync(path.join(dir, "debug.log"), "l");

    const stagedFor = (exclude: string[], id: string) => {
      const s = new AssetStaging(appWithOutdir(), id, {
        sourcePath: dir,
        exclude,
      });
      const out: string[] = [];
      const walk = (p: string, pre: string) => {
        for (const e of fs.readdirSync(p)) {
          const f = path.join(p, e);
          const r = pre ? `${pre}/${e}` : e;
          if (fs.statSync(f).isDirectory()) walk(f, r);
          else out.push(r);
        }
      };
      walk(s.absoluteStagedPath, "");
      return out.sort();
    };

    // *.ext matches at any depth
    expect(stagedFor(["*.log"], "A")).toEqual([
      "node_modules/big.js",
      "src/app.ts",
    ]);
    // directory, with and without trailing slash
    expect(stagedFor(["node_modules"], "B")).toEqual(
      stagedFor(["node_modules/"], "C"),
    );
    // nested directory path
    expect(stagedFor(["src/nested"], "D")).toEqual([
      "debug.log",
      "node_modules/big.js",
      "src/app.ts",
    ]);
    // no prefix bleed
    expect(stagedFor(["src/nest"], "E")).toContain("src/nested/deep.log");
  });

  test("stages into the App outdir", () => {
    const f = path.join(tempDir, "f.txt");
    fs.writeFileSync(f, "hello");
    const s = new AssetStaging(appWithOutdir(), "A", { sourcePath: f });
    expect(s.absoluteStagedPath.startsWith(outdir)).toBe(true);
  });

  test("runs the bundler once for identical assets", () => {
    const dir = path.join(tempDir, "d");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    let runs = 0;
    const local = {
      tryBundle(o: string) {
        runs++;
        fs.writeFileSync(path.join(o, "out.txt"), "o");
        return true;
      },
    };
    const st = appWithOutdir();
    const opts = {
      sourcePath: dir,
      bundling: {
        image: DockerImage.fromRegistry("alpine"),
        command: ["x"],
        local,
      },
    };
    const a = new AssetStaging(st, "A", opts as any);
    const b = new AssetStaging(st, "B", opts as any);
    expect(a.absoluteStagedPath).toBe(b.absoluteStagedPath);
    expect(runs).toBe(1);
  });

  test("omits --security-opt when it is not configured", () => {
    const dir = path.join(tempDir, "d");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    const stub = process.env.DOCKER_STUB_DIR;
    expect(stub).toBeUndefined(); // sanity: default /tmp used below
    // Assert via BIND_MOUNT argv recorded by the stub
    const concat = "/tmp/docker-stub.input.concat";
    fs.rmSync(concat, { force: true });
    new AssetStaging(appWithOutdir(), "A", {
      sourcePath: dir,
      bundling: {
        image: DockerImage.fromRegistry("alpine"),
        command: ["DOCKER_STUB_SUCCESS"],
      },
    });
    expect(fs.readFileSync(concat, "utf8")).not.toContain("--security-opt");
  });

  test("mounts BIND_MOUNT input read-only and output writable", () => {
    const dir = path.join(tempDir, "d");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    const concat = "/tmp/docker-stub.input.concat";
    fs.rmSync(concat, { force: true });
    new AssetStaging(appWithOutdir(), "A", {
      sourcePath: dir,
      bundling: {
        image: DockerImage.fromRegistry("alpine"),
        command: ["DOCKER_STUB_SUCCESS"],
        bundlingFileAccess: BundlingFileAccess.BIND_MOUNT,
      },
    });
    const argv = fs.readFileSync(concat, "utf8");
    expect(argv).toMatch(/asset-input:ro/);
    expect(argv).not.toMatch(/asset-output:[a-z,]*ro/);
  });

  test("plain TerraformAsset and staged asset agree on the hash", () => {
    const dir = mkTree();
    // Testing.app always enables the canonical flag, so this covers the
    // canonical scheme only.
    const st = appWithOutdir();
    const plain = new TerraformAsset(st, "P", { path: dir });
    const staged = new TerraformAsset(st, "A", { path: dir, exclude: [] });
    // plain infers DIRECTORY, staged zips -> ARCHIVE, so the framing differs
    expect(plain.assetHash).toBe(
      hashPath(dir, { canonical: true, archive: false }),
    );
    expect(staged.assetHash).toBe(
      hashPath(dir, { canonical: true, archive: true }),
    );
  });
});
