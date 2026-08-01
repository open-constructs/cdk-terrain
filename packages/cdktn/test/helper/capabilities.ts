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

/** `test` that is skipped unless the system `unzip` is available. */
export const testIfUnzip = hasUnzip ? test : test.skip;

/** `test` that is skipped unless symlinks and the system `unzip` both work. */
export const testIfSymlinksAndUnzip =
  canCreateSymlinks && hasUnzip ? test : test.skip;

/** `test` that is skipped unless the filesystem has POSIX permission bits. */
export const testIfPosixPermissions = hasPosixPermissions ? test : test.skip;

/** `describe` that is skipped unless symlinks can be created. */
export const describeIfSymlinks = canCreateSymlinks ? describe : describe.skip;
