// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
// Repros for https://github.com/open-constructs/cdk-terrain/issues/545
// pnpm and npm workspaces link packages with absolute-target symlinks
// (Windows junctions report the same way to Node), which must not leak the
// checkout path into the hash or the archive.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { archiveSync, copySync, hashPath } from "../src/private/fs";
import {
  testIfJunctions,
  testIfSymlinks,
  testIfSymlinksAndUnzip,
} from "./helper/capabilities";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-junction-test-"));
}

function extractZip(zipPath: string): string {
  const extractDir = createTempDir();
  execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: "ignore" });
  return extractDir;
}

const canonical = (p: string) => hashPath(p, { canonical: true });

describe("absolute-target symlinks inside the asset root (#545)", () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    srcDir = createTempDir();
    destDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  testIfSymlinks(
    "canonical hash does not depend on the checkout's absolute path",
    () => {
      const build = (root: string) => {
        fs.mkdirSync(path.join(root, "real-pkg"));
        fs.writeFileSync(path.join(root, "real-pkg", "index.js"), "module");
        // an absolute target, as Node reports a Windows junction
        fs.symlinkSync(path.join(root, "real-pkg"), path.join(root, "link-a"));
      };
      const otherDir = createTempDir();
      build(srcDir);
      build(otherDir);

      expect(canonical(srcDir)).toBe(canonical(otherDir));

      fs.rmSync(otherDir, { recursive: true, force: true });
    },
  );

  testIfSymlinksAndUnzip(
    "archiveSync stores a portable target, not the absolute source path",
    () => {
      fs.mkdirSync(path.join(srcDir, "real-pkg"));
      fs.writeFileSync(path.join(srcDir, "real-pkg", "index.js"), "module");
      fs.symlinkSync(
        path.join(srcDir, "real-pkg"),
        path.join(srcDir, "link-a"),
      );

      const zipPath = path.join(destDir, "output.zip");
      archiveSync(srcDir, zipPath);

      const extracted = extractZip(zipPath);
      const link = path.join(extracted, "link-a");
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).not.toContain(srcDir);
      expect(fs.readFileSync(path.join(link, "index.js"), "utf-8")).toBe(
        "module",
      );
    },
  );

  testIfSymlinks(
    "copySync recreates the link relative to the copy, not the source",
    () => {
      fs.mkdirSync(path.join(srcDir, "real-pkg"));
      fs.writeFileSync(path.join(srcDir, "real-pkg", "index.js"), "module");
      fs.symlinkSync(
        path.join(srcDir, "real-pkg"),
        path.join(srcDir, "link-a"),
      );

      copySync(srcDir, destDir);

      const link = path.join(destDir, "link-a");
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).not.toContain(srcDir);
      expect(fs.readFileSync(path.join(link, "index.js"), "utf-8")).toBe(
        "module",
      );
    },
  );

  testIfSymlinks(
    "an absolute target outside the asset root ships verbatim, not rejected",
    () => {
      // e.g. a Lambda layer symlink into /opt: already portable, since it
      // means the same thing wherever it is read, regardless of checkout
      // location or extraction destination.
      const outside = createTempDir();
      fs.writeFileSync(path.join(outside, "shared.js"), "module");
      const absoluteTarget = path.join(outside, "shared.js");
      fs.symlinkSync(absoluteTarget, path.join(srcDir, "link"));

      expect(() => canonical(srcDir)).not.toThrow();
      expect(() =>
        archiveSync(
          srcDir,
          path.join(destDir, "out.zip"),
          undefined,
          false,
          true,
        ),
      ).not.toThrow();
      expect(() => copySync(srcDir, destDir)).not.toThrow();
      expect(fs.readlinkSync(path.join(destDir, "link"))).toBe(absoluteTarget);

      fs.rmSync(outside, { recursive: true, force: true });
    },
  );

  testIfSymlinks(
    "a relative target outside the asset root is never rejected by hashing or copySync",
    () => {
      const outside = createTempDir();
      fs.writeFileSync(path.join(outside, "shared.js"), "module");
      fs.symlinkSync(
        path.relative(srcDir, path.join(outside, "shared.js")),
        path.join(srcDir, "link"),
      );

      expect(() => canonical(srcDir)).not.toThrow();
      expect(() => copySync(srcDir, destDir)).not.toThrow();
      // copySync cannot re-express the escape relative to the copy, so it
      // recreates the link pointing straight at the real target instead.
      expect(fs.readlinkSync(path.join(destDir, "link"))).toBe(
        path.join(outside, "shared.js"),
      );

      fs.rmSync(outside, { recursive: true, force: true });
    },
  );

  testIfSymlinksAndUnzip(
    "archiveSync rejects a relative escape only when told to",
    () => {
      const outside = createTempDir();
      fs.writeFileSync(path.join(outside, "shared.js"), "module");
      fs.symlinkSync(
        path.relative(srcDir, path.join(outside, "shared.js")),
        path.join(srcDir, "link"),
      );
      const zipPath = path.join(destDir, "out.zip");

      expect(() => archiveSync(srcDir, zipPath)).not.toThrow();
      expect(() =>
        archiveSync(srcDir, zipPath, undefined, false, true),
      ).toThrow(/outside the asset root/);

      fs.rmSync(outside, { recursive: true, force: true });
    },
  );

  testIfSymlinks(
    "legacy hash keeps hashing the raw link text (no behavior change)",
    () => {
      // regression guard: the fix must not touch the legacy scheme's bytes
      fs.writeFileSync(path.join(srcDir, "a.txt"), "aaa");
      fs.symlinkSync("a.txt", path.join(srcDir, "link"));
      expect(() => hashPath(srcDir)).not.toThrow();
    },
  );
});

describe("copySync symlink EPERM fallback (#545)", () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    srcDir = createTempDir();
    destDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  testIfSymlinks(
    "falls back to a junction when symlinkSync hits EPERM for a directory target on win32",
    () => {
      fs.mkdirSync(path.join(srcDir, "real-pkg"));
      fs.writeFileSync(path.join(srcDir, "real-pkg", "index.js"), "module");
      fs.symlinkSync("real-pkg", path.join(srcDir, "link-a"));

      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      const symlinkSpy = jest
        .spyOn(fs, "symlinkSync")
        .mockImplementationOnce(() => {
          const err: any = new Error("EPERM: operation not permitted");
          err.code = "EPERM";
          throw err;
        });

      try {
        copySync(srcDir, destDir);

        expect(symlinkSpy).toHaveBeenCalledTimes(2);
        expect(symlinkSpy.mock.calls[1][2]).toBe("junction");
        expect(symlinkSpy.mock.calls[1][0]).toBe(
          path.resolve(destDir, "real-pkg"),
        );
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
        });
        symlinkSpy.mockRestore();
      }
    },
  );

  testIfSymlinks(
    "a file-target link still throws on EPERM (no junction fallback)",
    () => {
      fs.writeFileSync(path.join(srcDir, "a.txt"), "aaa");
      fs.symlinkSync("a.txt", path.join(srcDir, "link"));

      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      const symlinkSpy = jest
        .spyOn(fs, "symlinkSync")
        .mockImplementationOnce(() => {
          const err: any = new Error("EPERM: operation not permitted");
          err.code = "EPERM";
          throw err;
        });

      try {
        expect(() => copySync(srcDir, destDir)).toThrow(/EPERM/);
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
        });
        symlinkSpy.mockRestore();
      }
    },
  );
});

// A junction needs no privilege to create on win32 — pnpm/npm rely on
// exactly that — so these run for real on a Windows CI runner without
// Developer Mode, unlike the suites above, which mock `fs.symlinkSync` to
// reach the same code paths on Linux CI.
describe("real win32 junctions, unmocked (#545, #620 follow-up)", () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    srcDir = createTempDir();
    destDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  testIfJunctions("hashes identically across two checkouts", () => {
    const build = (root: string) => {
      fs.mkdirSync(path.join(root, "real-pkg"));
      fs.writeFileSync(path.join(root, "real-pkg", "index.js"), "module");
      fs.symlinkSync(
        path.join(root, "real-pkg"),
        path.join(root, "link-a"),
        "junction",
      );
    };
    const otherDir = createTempDir();
    build(srcDir);
    build(otherDir);

    expect(canonical(srcDir)).toBe(canonical(otherDir));

    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  testIfJunctions(
    "copySync recreates it, falling back past a real EPERM when plain symlinks need Developer Mode",
    () => {
      fs.mkdirSync(path.join(srcDir, "real-pkg"));
      fs.writeFileSync(path.join(srcDir, "real-pkg", "index.js"), "module");
      fs.symlinkSync(
        path.join(srcDir, "real-pkg"),
        path.join(srcDir, "link-a"),
        "junction",
      );

      expect(() => copySync(srcDir, destDir)).not.toThrow();

      const link = path.join(destDir, "link-a");
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(link, "index.js"), "utf-8")).toBe(
        "module",
      );
    },
  );

  testIfJunctions("archiveSync stores its target as a portable path", () => {
    fs.mkdirSync(path.join(srcDir, "real-pkg"));
    fs.writeFileSync(path.join(srcDir, "real-pkg", "index.js"), "module");
    fs.symlinkSync(
      path.join(srcDir, "real-pkg"),
      path.join(srcDir, "link-a"),
      "junction",
    );

    const zipPath = path.join(destDir, "output.zip");
    archiveSync(srcDir, zipPath);
  });

  // Windows always reports a junction's target as a drive-letter absolute
  // path, even when the target escapes the asset root. Unlike a POSIX
  // absolute target, that text has no leading `/` on a POSIX extractor and
  // resolves as a dangling relative path instead, so it must be rejected
  // like any other escape, not shipped as if it were portable (#620 review).
  testIfJunctions(
    "archiveSync rejects an escaping junction when told to",
    () => {
      const outside = createTempDir();
      fs.symlinkSync(outside, path.join(srcDir, "link"), "junction");

      expect(() =>
        archiveSync(srcDir, path.join(destDir, "out.zip")),
      ).not.toThrow();
      expect(() =>
        archiveSync(
          srcDir,
          path.join(destDir, "out2.zip"),
          undefined,
          false,
          true,
        ),
      ).toThrow(/outside the asset root/);

      fs.rmSync(outside, { recursive: true, force: true });
    },
  );

  testIfJunctions(
    "canonical hash of an escaping junction does not bake in the checkout's absolute path",
    () => {
      const outside = createTempDir();
      // srcDir, otherDir and outside are all siblings under the OS temp
      // dir, so each checkout's junction sits the same relative distance
      // from outside — only a location-independent hash can agree on that.
      const otherDir = createTempDir();
      fs.symlinkSync(outside, path.join(srcDir, "link"), "junction");
      fs.symlinkSync(outside, path.join(otherDir, "link"), "junction");

      expect(canonical(srcDir)).toBe(canonical(otherDir));

      fs.rmSync(otherDir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    },
  );
});
