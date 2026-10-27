// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

// Capability probes for tests that depend on POSIX-only filesystem behaviour
// or on external tools.
//
// These are probed rather than derived from `process.platform` so that a
// Windows developer who has enabled Developer Mode, or installed unzip, gets
// the coverage instead of a permanently skipped suite.

import { execFileSync, execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as semver from "semver";
import { terraformBinaryName } from "../../src/util";
import { parseTerraformCliVersion } from "../../src/validations/validate-terraform-feature-version";

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

/**
 * `test` that is skipped unless the filesystem has POSIX permission bits and
 * the system `unzip` is available. Needed by tests that set a mode bit and
 * then read it back out of the archive with the external extractor.
 */
export const testIfPosixPermissionsAndUnzip =
  hasPosixPermissions && hasUnzip ? test : test.skip;

/** `describe` that is skipped unless symlinks can be created. */
export const describeIfSymlinks = canCreateSymlinks ? describe : describe.skip;

/**
 * Whether the CLI the testing matchers run (`TERRAFORM_BINARY_NAME`, default
 * `terraform`) supports the `convert` function (Terraform >= 1.15.0, OpenTofu
 * >= 1.13.0), and why not if it doesn't. CI runs the unit tests against
 * older binaries too, which reject any config that calls convert().
 */
export const convertSupport: { supported: boolean; reason: string } = (() => {
  let output: string;
  try {
    output = execSync(`${terraformBinaryName} version`, {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return {
      supported: false,
      reason: `"${terraformBinaryName}" is not available`,
    };
  }
  const { name, version } = parseTerraformCliVersion(output);
  const minimum =
    name === "terraform"
      ? "1.15.0"
      : name === "opentofu"
        ? "1.13.0"
        : undefined;
  if (!minimum || !version || !semver.valid(version)) {
    return {
      supported: false,
      reason: `"${terraformBinaryName}" reports an unrecognized version`,
    };
  }
  if (semver.lt(version, minimum)) {
    return {
      supported: false,
      reason: `${name} ${version} has no convert() (needs >=${minimum})`,
    };
  }
  return { supported: true, reason: "" };
})();

/**
 * `test` that is skipped, with the reason appended to its name, unless the
 * matchers' CLI supports convert().
 */
export const testIfConvertSupported: jest.It = convertSupport.supported
  ? test
  : (((name: string, ...rest: any[]) =>
      (test.skip as any)(
        `${name} [skipped: ${convertSupport.reason}]`,
        ...rest,
      )) as unknown as jest.It);
