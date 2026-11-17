// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  BundleOutputType,
  BundleResult,
  BundlerKey,
  ChainBundler,
  TerraformHclModule,
  TerraformStack,
  Testing,
} from "../src";
import * as path from "path";
import { TerraformModuleAsset } from "../src/terraform-module-asset";

describe("createAssetsFromLocalModules", () => {
  test("remote source without skipAssetCreationFromLocalModules", () => {
    const remoteSource = "terraform-aws-modules/eks/aws";

    const app = Testing.app({
      enableFutureFlags: false,
      context: { cdktfJsonPath: path.resolve(__dirname, "fixtures/app") },
    });
    const stack = new TerraformStack(app, "MyStack");

    const moduleOptionsNotExists = new TerraformHclModule(
      stack,
      "moduleOptionsNotExists",
      {
        source: remoteSource,
      },
    );

    expect(moduleOptionsNotExists.source).toEqual(remoteSource);
  });

  test("remote source with skipAssetCreationFromLocalModules set to true", () => {
    const remoteSource = "terraform-aws-modules/eks/aws";

    const app = Testing.app({
      enableFutureFlags: false,
      context: { cdktfJsonPath: path.resolve(__dirname, "fixtures/app") },
    });
    const stack = new TerraformStack(app, "MyStack");

    const moduleOptionsTrue = new TerraformHclModule(
      stack,
      "moduleOptionsTrue",
      {
        source: remoteSource,
        skipAssetCreationFromLocalModules: true,
      },
    );

    expect(moduleOptionsTrue.source).toEqual(remoteSource);
  });

  test("remote source with skipAssetCreationFromLocalModules set to false", () => {
    const remoteSource = "terraform-aws-modules/eks/aws";

    const app = Testing.app({
      enableFutureFlags: false,
      context: { cdktfJsonPath: path.resolve(__dirname, "fixtures/app") },
    });
    const stack = new TerraformStack(app, "MyStack");

    const moduleOptionsFalse = new TerraformHclModule(
      stack,
      "moduleOptionsFalse",
      {
        source: remoteSource,
        skipAssetCreationFromLocalModules: false,
      },
    );

    expect(moduleOptionsFalse.source).toEqual(remoteSource);
  });

  test("local source without skipAssetCreationFromLocalModules", () => {
    const localSource = "./test/fixtures/hcl-module/";

    const app = Testing.app({
      enableFutureFlags: false,
      context: {
        cdktfJsonPath: path.resolve(__dirname, "fixtures/app"),
        cdktfRelativeModules: [localSource],
      },
    });
    const stack = new TerraformStack(app, "MyStack");

    const moduleOptionsNotExists = new TerraformHclModule(
      stack,
      "moduleOptionsNotExists",
      {
        source: localSource,
      },
    );

    const terraformModuleAssetSource =
      TerraformModuleAsset.of(stack).getAssetPathForModule(localSource);

    expect(moduleOptionsNotExists.source).toEqual(terraformModuleAssetSource);
  });

  test("local source with skipAssetCreationFromLocalModules set to false", () => {
    const localSource = "./test/fixtures/hcl-module/";
    const cdktfJsonPath = path.resolve(__dirname, "fixtures/app");

    const app = Testing.app({
      enableFutureFlags: false,
      context: {
        cdktfJsonPath,
        cdktfRelativeModules: [localSource],
      },
    });
    const stack = new TerraformStack(app, "MyStack");

    const moduleOptionsTrue = new TerraformHclModule(
      stack,
      "moduleOptionsTrue",
      {
        source: localSource,
        skipAssetCreationFromLocalModules: false,
      },
    );

    const terraformModuleAssetSource =
      TerraformModuleAsset.of(stack).getAssetPathForModule(localSource);

    expect(moduleOptionsTrue.source).toEqual(terraformModuleAssetSource);
  });

  test("local source with skipAssetCreationFromLocalModules set to true", () => {
    const localSource = "./test/fixtures/hcl-module/";

    const app = Testing.app({
      enableFutureFlags: false,
      context: { cdktfJsonPath: path.resolve(__dirname, "fixtures/app") },
    });
    const stack = new TerraformStack(app, "MyStack");

    const moduleOptionsFalse = new TerraformHclModule(
      stack,
      "moduleOptionsFalse",
      {
        source: localSource,
        skipAssetCreationFromLocalModules: true,
      },
    );

    expect(moduleOptionsFalse.source).toEqual(localSource);
  });
});

describe("BundlerKey", () => {
  test("joins ordered parts, escaping the separator inside a part", () => {
    // The colon inside "node:20" is escaped so it cannot be mistaken for a
    // part boundary.
    expect(BundlerKey.of("docker", "node:20", "npm run build").toString()).toBe(
      "docker:node\\:20:npm run build",
    );
  });

  test("order is significant", () => {
    expect(BundlerKey.of("a", "b").toString()).not.toBe(
      BundlerKey.of("b", "a").toString(),
    );
  });

  test("escapes the separator so distinct inputs cannot collide", () => {
    expect(BundlerKey.of("a:b", "c").toString()).not.toBe(
      BundlerKey.of("a", "b:c").toString(),
    );
  });

  test("add appends parts", () => {
    expect(BundlerKey.of("docker").add("node:20", "build").toString()).toBe(
      BundlerKey.of("docker", "node:20", "build").toString(),
    );
  });

  test("withEnv sorts record entries so property order does not matter", () => {
    const a = BundlerKey.of("base").withEnv({ B: "2", A: "1" }).toString();
    const b = BundlerKey.of("base").withEnv({ A: "1", B: "2" }).toString();
    expect(a).toBe(b);
  });

  test("different env values produce different keys", () => {
    const dev = BundlerKey.of("build").withEnv({ NODE_ENV: "development" });
    const prod = BundlerKey.of("build").withEnv({ NODE_ENV: "production" });
    expect(dev.toString()).not.toBe(prod.toString());
  });

  test("withEnv entries cannot collide with an add() part in the same shape", () => {
    const viaAdd = BundlerKey.of("tool").add("helper=busybox").toString();
    const viaEnv = BundlerKey.of("tool")
      .withEnv({ helper: "busybox" })
      .toString();
    expect(viaAdd).not.toBe(viaEnv);
  });

  test("an '=' inside an env key or value cannot collide two different records", () => {
    const a = BundlerKey.of("x").withEnv({ a: "b=c" }).toString();
    const b = BundlerKey.of("x").withEnv({ "a=b": "c" }).toString();
    expect(a).not.toBe(b);
  });
});

describe("BundleResult", () => {
  test("directory carries a DIRECTORY output type and the path", () => {
    const result = BundleResult.directory("/tmp/out");
    expect(result.outputType).toBe(BundleOutputType.DIRECTORY);
    expect(result.path).toBe("/tmp/out");
    expect(result.isDeclined).toBe(false);
  });

  test("file carries a FILE output type and the path", () => {
    const result = BundleResult.file("/tmp/archive.zip");
    expect(result.outputType).toBe(BundleOutputType.FILE);
    expect(result.path).toBe("/tmp/archive.zip");
    expect(result.isDeclined).toBe(false);
  });

  test("declined has no path and is marked declined", () => {
    const result = BundleResult.declined();
    expect(result.isDeclined).toBe(true);
    expect(result.path).toBeUndefined();
  });
});

describe("ChainBundler", () => {
  const declines = { bundle: () => BundleResult.declined() };
  const runs = {
    bundle: (opts: { outputDir: string; source: string }) =>
      BundleResult.directory(opts.outputDir),
  };

  test("of() requires at least one bundler", () => {
    expect(() => ChainBundler.of()).toThrow(/at least one/i);
  });

  test("bundlerKey folds in every leg's key so it depends on both", () => {
    const both = ChainBundler.of(
      { bundlerKey: "local:v1", bundle: runs.bundle },
      { bundlerKey: "docker:v1", bundle: declines.bundle },
    );
    const localOnly = ChainBundler.of({
      bundlerKey: "local:v1",
      bundle: runs.bundle,
    });
    const differentDocker = ChainBundler.of(
      { bundlerKey: "local:v1", bundle: runs.bundle },
      { bundlerKey: "docker:v2", bundle: declines.bundle },
    );

    expect(both.bundlerKey).not.toEqual(localOnly.bundlerKey);
    expect(both.bundlerKey).not.toEqual(differentDocker.bundlerKey);
  });

  test("bundlerKey is undefined when no leg contributes a key", () => {
    const chain = ChainBundler.of(runs, declines);
    expect(chain.bundlerKey).toBeUndefined();
  });

  test("two legs with the same single key differ from one leg", () => {
    const one = ChainBundler.of({ bundlerKey: "k", bundle: runs.bundle });
    const two = ChainBundler.of(
      { bundlerKey: "k", bundle: declines.bundle },
      { bundlerKey: "k", bundle: runs.bundle },
    );
    expect(one.bundlerKey).not.toEqual(two.bundlerKey);
  });

  test("outputFileName is taken from the legs that declare one", () => {
    const chain = ChainBundler.of(
      { outputFileName: "archive.zip", bundle: declines.bundle },
      { bundle: runs.bundle },
    );
    expect(chain.outputFileName).toBe("archive.zip");
  });

  test("legs may agree on outputFileName", () => {
    const chain = ChainBundler.of(
      { outputFileName: "archive.zip", bundle: declines.bundle },
      { outputFileName: "archive.zip", bundle: runs.bundle },
    );
    expect(chain.outputFileName).toBe("archive.zip");
  });

  test("conflicting outputFileName across legs throws", () => {
    expect(() =>
      ChainBundler.of(
        { outputFileName: "a.zip", bundle: declines.bundle },
        { outputFileName: "b.zip", bundle: runs.bundle },
      ),
    ).toThrow(/conflicting outputFileName/i);
  });

  test("outputFileName is undefined when no leg declares one", () => {
    const chain = ChainBundler.of(runs, declines);
    expect(chain.outputFileName).toBeUndefined();
  });
});
