// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

// Capability probes for tests that depend on POSIX-only filesystem behaviour
// or on external tools.
//
// These are probed rather than derived from `process.platform` so that a
// Windows developer who has enabled Developer Mode, or installed unzip, gets
// the coverage instead of a permanently skipped suite.

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Whether this process can create symlinks. On Windows this requires
 * Developer Mode or an elevated shell; without either `fs.symlinkSync` fails
 * with EPERM.
 */
export const canCreateSymlinks: boolean = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(dir, "target"), "");
    fs.symlinkSync("target", path.join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

/**
 * Whether this process can create a win32 junction. Unlike a plain symlink,
 * a junction needs no privilege on Windows — that is the whole reason
 * pnpm/npm workspaces use one — so this exercises real junction creation and
 * resolution on CI runners without Developer Mode, rather than only the
 * `fs.symlinkSync` EPERM path mocked elsewhere.
 *
 * Always false off win32: `type` is ignored there, so a "junction" would
 * just be the plain symlink `canCreateSymlinks` already covers.
 */
export const canCreateJunctions: boolean = (() => {
  if (process.platform !== "win32") {
    return false;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-junction-probe-"));
  try {
    fs.mkdirSync(path.join(dir, "target"));
    fs.symlinkSync(
      path.join(dir, "target"),
      path.join(dir, "link"),
      "junction",
    );
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

/**
 * Whether the system `unzip` binary is available.
 *
 * The archive tests that use it do so deliberately: they validate archives
 * written by fflate against an independent extractor. Falling back to fflate
 * would make those assertions circular, so they are skipped instead.
 */
export const hasUnzip: boolean = (() => {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Whether the filesystem carries POSIX permission bits. Windows does not, so
 * `fs.chmodSync` cannot set an executable bit for archiveSync to record.
 */
export const hasPosixPermissions: boolean = process.platform !== "win32";

/** `test` that is skipped unless symlinks can be created. */
export const testIfSymlinks = canCreateSymlinks ? test : test.skip;

/** `test` that is skipped unless a win32 junction can be created. */
export const testIfJunctions = canCreateJunctions ? test : test.skip;

/** `test` that is skipped unless the system `unzip` is available. */
export const testIfUnzip = hasUnzip ? test : test.skip;

/** `test` that is skipped unless symlinks and the system `unzip` both work. */
export const testIfSymlinksAndUnzip =
  canCreateSymlinks && hasUnzip ? test : test.skip;

/** `test` that is skipped unless the filesystem has POSIX permission bits. */
export const testIfPosixPermissions = hasPosixPermissions ? test : test.skip;

/**
 * `test` that is skipped unless the filesystem has POSIX permission bits and
 * the system `unzip` is available. Needed by tests that set a mode bit and
 * then read it back out of the archive with the external extractor.
 */
export const testIfPosixPermissionsAndUnzip =
  hasPosixPermissions && hasUnzip ? test : test.skip;

/** `describe` that is skipped unless symlinks can be created. */
export const describeIfSymlinks = canCreateSymlinks ? describe : describe.skip;
