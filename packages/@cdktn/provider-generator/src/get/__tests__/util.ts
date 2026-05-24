// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as os from "os";
import {
  Language,
  TerraformModuleConstraint,
  withTempDir,
} from "@cdktn/commons";
import { ConstructsMaker } from "../constructs-maker";
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
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  return (prefix: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  };
}

export function expectModuleToMatchSnapshot(
  testName: string,
  testCategory: string,
  fixtureNames: string[],
) {
  test(testName, async () => {
    await withTempDir(`${testName.replace(/\s*/, "-")}.test`, async () => {
      const curdir = process.cwd();
      fs.mkdirSync("module");

      fixtureNames.forEach((fixtureName) => {
        fs.copyFileSync(
          path.join(__dirname, testCategory, "fixtures", fixtureName),
          path.join(curdir, "module", fixtureName),
        );
      });

      const constraint = new TerraformModuleConstraint({
        source: "./module",
        name: "module",
        fqn: "module",
      });

      fs.mkdirSync("work");
      const workdir = path.join(curdir, "work");

      const maker = new ConstructsMaker(
        {
          codeMakerOutput: workdir,
          targetLanguage: Language.TYPESCRIPT,
        },
        process.env.CDKTF_EXPERIMENTAL_PROVIDER_SCHEMA_CACHE_PATH,
      );
      await maker.generate([constraint]);

      const output = fs.readFileSync(
        path.join(workdir, "modules/module.ts"),
        "utf-8",
      );
      expect(output).toMatchSnapshot();
    });
  });
}
