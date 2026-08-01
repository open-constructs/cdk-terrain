// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Creates a per-test-file temp-dir helper.
 *
 * Returns a `tmp(prefix)` function that creates a uniquely-named directory
 * under `os.tmpdir()` and tracks it. An `afterAll` hook is registered on
 * the calling test file's scope; when the file finishes running, every
 * tracked directory is removed (recursively, force).
 */
export function createTmpHelper(): (prefix: string) => string {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) {
      try {
        // Windows frequently holds transient handles on just-written files
        // (search indexer, AV scanners), which surfaces as EBUSY/EPERM. Retry,
        // and never let cleanup of a temp directory fail the suite itself --
        // these live under os.tmpdir() and the OS reclaims them regardless.
        fs.rmSync(d, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      } catch (e) {
        console.warn(`Could not remove temp dir ${d}: ${(e as Error).message}`);
      }
    }
  });
  return (prefix: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  };
}
