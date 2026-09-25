// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  BundlerKey,
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
});
