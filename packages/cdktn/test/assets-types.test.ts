// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

import {
  AssetHashType,
  FileAssetPackaging,
  type FileAssetSource,
  type DockerImageAssetSource,
  type FileAssetLocation,
  type DockerImageAssetLocation,
  type AssetOptions,
} from "../lib";

describe("Assets Types", () => {
  describe("AssetHashType", () => {
    test("has expected values", () => {
      expect(AssetHashType.SOURCE).toBe("source");
      expect(AssetHashType.OUTPUT).toBe("output");
      expect(AssetHashType.CUSTOM).toBe("custom");
    });
  });

  describe("FileAssetPackaging", () => {
    test("has expected values", () => {
      expect(FileAssetPackaging.ZIP_DIRECTORY).toBe("zip");
      expect(FileAssetPackaging.FILE).toBe("file");
    });
  });

  describe("FileAssetSource", () => {
    test("can be created with required fields", () => {
      const source: FileAssetSource = {
        sourceHash: "abc123",
        fileName: "path/to/asset.zip",
        packaging: FileAssetPackaging.FILE,
      };

      expect(source.sourceHash).toBe("abc123");
      expect(source.fileName).toBe("path/to/asset.zip");
      expect(source.packaging).toBe(FileAssetPackaging.FILE);
    });

    test("can include optional fields", () => {
      const source: FileAssetSource = {
        sourceHash: "abc123",
        fileName: "path/to/asset",
        packaging: FileAssetPackaging.ZIP_DIRECTORY,
        deployTime: true,
        displayName: "My Asset",
      };

      expect(source.deployTime).toBe(true);
      expect(source.displayName).toBe("My Asset");
    });
  });

  describe("DockerImageAssetSource", () => {
    test("can be created with required fields", () => {
      const source: DockerImageAssetSource = {
        sourceHash: "def456",
        directoryName: "path/to/dockerfile/dir",
      };

      expect(source.sourceHash).toBe("def456");
      expect(source.directoryName).toBe("path/to/dockerfile/dir");
    });

    test("can include docker build options", () => {
      const source: DockerImageAssetSource = {
        sourceHash: "def456",
        directoryName: "path/to/dockerfile/dir",
        dockerBuildArgs: { NODE_ENV: "production" },
        dockerBuildTarget: "production",
        dockerFile: "Dockerfile.prod",
        platform: "linux/amd64",
        dockerCacheDisabled: false,
      };

      expect(source.dockerBuildArgs).toEqual({ NODE_ENV: "production" });
      expect(source.dockerBuildTarget).toBe("production");
      expect(source.dockerFile).toBe("Dockerfile.prod");
      expect(source.platform).toBe("linux/amd64");
    });

    test("can include cache options", () => {
      const source: DockerImageAssetSource = {
        sourceHash: "def456",
        directoryName: "path/to/dockerfile/dir",
        dockerCacheFrom: [
          { type: "registry", params: { ref: "myrepo/cache:latest" } },
        ],
        dockerCacheTo: {
          type: "registry",
          params: { ref: "myrepo/cache:latest", mode: "max" },
        },
      };

      expect(source.dockerCacheFrom).toHaveLength(1);
      expect(source.dockerCacheFrom![0].type).toBe("registry");
      expect(source.dockerCacheTo?.params?.mode).toBe("max");
    });
  });

  describe("FileAssetLocation", () => {
    test("can represent AWS S3 location", () => {
      const location: FileAssetLocation = {
        bucketName: "my-bucket",
        objectKey: "assets/abc123.zip",
        httpUrl:
          "https://s3-us-east-1.amazonaws.com/my-bucket/assets/abc123.zip",
        objectUrl: "s3://my-bucket/assets/abc123.zip",
      };

      expect(location.bucketName).toBe("my-bucket");
      expect(location.httpUrl).toContain("s3-us-east-1");
      expect(location.objectUrl).toContain("s3://");
    });

    test("can represent Azure Blob Storage location", () => {
      const location: FileAssetLocation = {
        bucketName: "mycontainer",
        objectKey: "assets/abc123.zip",
        httpUrl:
          "https://mystorageaccount.blob.core.windows.net/mycontainer/assets/abc123.zip",
        objectUrl: "az://mycontainer/assets/abc123.zip",
      };

      expect(location.bucketName).toBe("mycontainer");
      expect(location.httpUrl).toContain("blob.core.windows.net");
      expect(location.objectUrl).toContain("az://");
    });

    test("can represent GCS location", () => {
      const location: FileAssetLocation = {
        bucketName: "my-gcs-bucket",
        objectKey: "assets/abc123.zip",
        httpUrl:
          "https://storage.googleapis.com/my-gcs-bucket/assets/abc123.zip",
        objectUrl: "gs://my-gcs-bucket/assets/abc123.zip",
      };

      expect(location.bucketName).toBe("my-gcs-bucket");
      expect(location.httpUrl).toContain("storage.googleapis.com");
      expect(location.objectUrl).toContain("gs://");
    });
  });

  describe("DockerImageAssetLocation", () => {
    test("can represent AWS ECR location", () => {
      const location: DockerImageAssetLocation = {
        imageUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:abc123",
        repositoryName: "my-repo",
        imageTag: "abc123",
      };

      expect(location.imageUri).toContain("dkr.ecr");
      expect(location.repositoryName).toBe("my-repo");
      expect(location.imageTag).toBe("abc123");
    });

    test("can represent Azure ACR location", () => {
      const location: DockerImageAssetLocation = {
        imageUri: "myregistry.azurecr.io/my-repo:abc123",
        repositoryName: "my-repo",
        imageTag: "abc123",
      };

      expect(location.imageUri).toContain("azurecr.io");
      expect(location.repositoryName).toBe("my-repo");
    });

    test("can represent GCP Artifact Registry location", () => {
      const location: DockerImageAssetLocation = {
        imageUri: "us-docker.pkg.dev/my-project/my-repo/my-image:abc123",
        repositoryName: "my-repo",
        imageTag: "abc123",
      };

      expect(location.imageUri).toContain("pkg.dev");
      expect(location.repositoryName).toBe("my-repo");
    });
  });

  describe("AssetOptions", () => {
    test("can specify custom hash", () => {
      const options: AssetOptions = {
        assetHash: "my-custom-hash",
        assetHashType: AssetHashType.CUSTOM,
      };

      expect(options.assetHash).toBe("my-custom-hash");
      expect(options.assetHashType).toBe(AssetHashType.CUSTOM);
    });

    test("can specify hash type without custom hash", () => {
      const options: AssetOptions = {
        assetHashType: AssetHashType.SOURCE,
      };

      expect(options.assetHashType).toBe(AssetHashType.SOURCE);
      expect(options.assetHash).toBeUndefined();
    });
  });

  describe("Multi-cloud FileAssetLocation examples", () => {
    test("can represent AWS S3 location", () => {
      const s3Location: FileAssetLocation = {
        bucketName: "my-bucket",
        objectKey: "assets/abc123.zip",
        httpUrl:
          "https://s3-us-east-1.amazonaws.com/my-bucket/assets/abc123.zip",
        objectUrl: "s3://my-bucket/assets/abc123.zip",
      };

      expect(s3Location.bucketName).toBe("my-bucket");
      expect(s3Location.objectUrl).toContain("s3://");
    });

    test("can represent Azure Blob Storage location", () => {
      const azureLocation: FileAssetLocation = {
        bucketName: "mycontainer",
        objectKey: "assets/abc123.zip",
        httpUrl:
          "https://mystorageaccount.blob.core.windows.net/mycontainer/assets/abc123.zip",
        objectUrl: "az://mycontainer/assets/abc123.zip",
      };

      expect(azureLocation.bucketName).toBe("mycontainer");
      expect(azureLocation.objectUrl).toContain("az://");
    });

    test("can represent GCS location", () => {
      const gcsLocation: FileAssetLocation = {
        bucketName: "my-gcs-bucket",
        objectKey: "assets/abc123.zip",
        httpUrl:
          "https://storage.googleapis.com/my-gcs-bucket/assets/abc123.zip",
        objectUrl: "gs://my-gcs-bucket/assets/abc123.zip",
      };

      expect(gcsLocation.bucketName).toBe("my-gcs-bucket");
      expect(gcsLocation.objectUrl).toContain("gs://");
    });
  });

  describe("Multi-cloud DockerImageAssetLocation examples", () => {
    test("can represent AWS ECR location", () => {
      const ecrLocation: DockerImageAssetLocation = {
        imageUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:abc123",
        repositoryName: "my-repo",
        imageTag: "abc123",
      };

      expect(ecrLocation.imageUri).toContain("ecr.us-east-1");
      expect(ecrLocation.repositoryName).toBe("my-repo");
    });

    test("can represent Azure ACR location", () => {
      const acrLocation: DockerImageAssetLocation = {
        imageUri: "myregistry.azurecr.io/my-repo:abc123",
        repositoryName: "my-repo",
        imageTag: "abc123",
      };

      expect(acrLocation.imageUri).toContain("azurecr.io");
      expect(acrLocation.repositoryName).toBe("my-repo");
    });

    test("can represent GCP Artifact Registry location", () => {
      const garLocation: DockerImageAssetLocation = {
        imageUri: "us-docker.pkg.dev/my-project/my-repo/my-image:abc123",
        repositoryName: "my-repo",
        imageTag: "abc123",
      };

      expect(garLocation.imageUri).toContain("pkg.dev");
      expect(garLocation.repositoryName).toBe("my-repo");
    });
  });
});
