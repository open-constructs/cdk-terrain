// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

import * as cdktn from "../lib";

describe("Assets Integration", () => {
  test("exports are available from main package", () => {
    expect(cdktn.AssetHashType).toBeDefined();
    expect(cdktn.FileAssetPackaging).toBeDefined();
  });

  test("can use types for type checking", () => {
    // This test verifies that the types compile correctly
    const asset: cdktn.FileAssetSource = {
      sourceHash: "abc123",
      fileName: "test.zip",
      packaging: cdktn.FileAssetPackaging.FILE,
    };

    const location: cdktn.FileAssetLocation = {
      bucketName: "my-bucket",
      objectKey: "test.zip",
      httpUrl: "https://example.com/test.zip",
      objectUrl: "s3://my-bucket/test.zip",
    };

    const dockerAsset: cdktn.DockerImageAssetSource = {
      sourceHash: "def456",
      directoryName: "./docker",
    };

    const dockerLocation: cdktn.DockerImageAssetLocation = {
      imageUri: "registry.example.com/my-image:latest",
      repositoryName: "my-image",
    };

    const options: cdktn.AssetOptions = {
      assetHashType: cdktn.AssetHashType.SOURCE,
    };

    expect(asset).toBeDefined();
    expect(location).toBeDefined();
    expect(dockerAsset).toBeDefined();
    expect(dockerLocation).toBeDefined();
    expect(options).toBeDefined();
  });

  test("IAsset interface can be implemented", () => {
    class MyAsset implements cdktn.IAsset {
      readonly assetHash: string = "test-hash";
    }

    const myAsset = new MyAsset();
    expect(myAsset.assetHash).toBe("test-hash");
  });

  test("enums have correct values", () => {
    expect(cdktn.AssetHashType.SOURCE).toBe("source");
    expect(cdktn.AssetHashType.OUTPUT).toBe("output");
    expect(cdktn.AssetHashType.CUSTOM).toBe("custom");
    expect(cdktn.FileAssetPackaging.FILE).toBe("file");
    expect(cdktn.FileAssetPackaging.ZIP_DIRECTORY).toBe("zip");
  });
});
