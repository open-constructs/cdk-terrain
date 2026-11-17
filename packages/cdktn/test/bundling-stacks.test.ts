// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
// Acceptance tests for https://github.com/open-constructs/cdk-terrain/issues/583:
// deferred bundler builds should skip stacks a CLI command will not run.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AssetType,
  BundleResult,
  TerraformAsset,
  TerraformStack,
  Testing,
} from "../src";
import { BUNDLING_STACKS_CONTEXT_KEY } from "../src/asset-staging";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-bundling-stacks-"));
}

function trackingBundler(onRun: () => void) {
  return {
    bundle: (opts: { outputDir: string }) => {
      onRun();
      return BundleResult.directory(opts.outputDir);
    },
  };
}

describe("BUNDLING_STACKS_CONTEXT_KEY (#583)", () => {
  let srcDir: string;

  beforeEach(() => {
    srcDir = createTempDir();
    fs.writeFileSync(path.join(srcDir, "a.txt"), "content");
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  test("bundles every stack when the context key is absent", () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, "this-stack");
    let ran = false;
    new TerraformAsset(stack, "Asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      bundler: trackingBundler(() => (ran = true)),
    });

    Testing.fullSynth(stack);

    expect(ran).toBe(true);
  });

  test("skips the bundler for a stack not named in the context key", () => {
    const app = Testing.app({
      context: { [BUNDLING_STACKS_CONTEXT_KEY]: ["other-stack"] },
    });
    const stack = new TerraformStack(app, "this-stack");
    let ran = false;
    new TerraformAsset(stack, "Asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      bundler: trackingBundler(() => (ran = true)),
    });

    Testing.fullSynth(stack);

    expect(ran).toBe(false);
  });

  test("runs the bundler for a stack named in the context key", () => {
    const app = Testing.app({
      context: { [BUNDLING_STACKS_CONTEXT_KEY]: ["other-stack", "this-stack"] },
    });
    const stack = new TerraformStack(app, "this-stack");
    let ran = false;
    new TerraformAsset(stack, "Asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      bundler: trackingBundler(() => (ran = true)),
    });

    Testing.fullSynth(stack);

    expect(ran).toBe(true);
  });

  test("matches a stack name against a glob pattern, like the CLI's own stack selectors", () => {
    const app = Testing.app({
      context: { [BUNDLING_STACKS_CONTEXT_KEY]: ["this-*"] },
    });
    const stack = new TerraformStack(app, "this-stack");
    let ran = false;
    new TerraformAsset(stack, "Asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      bundler: trackingBundler(() => (ran = true)),
    });

    Testing.fullSynth(stack);

    expect(ran).toBe(true);
  });

  test("over-matches (bundles) rather than under-matching for minimatch-only syntax this matcher does not understand", () => {
    const app = Testing.app({
      context: { [BUNDLING_STACKS_CONTEXT_KEY]: ["stack-{a,b}"] },
    });
    const stack = new TerraformStack(app, "stack-a");
    let ran = false;
    new TerraformAsset(stack, "Asset", {
      path: srcDir,
      type: AssetType.DIRECTORY,
      bundler: trackingBundler(() => (ran = true)),
    });

    Testing.fullSynth(stack);

    expect(ran).toBe(true);
  });
});
