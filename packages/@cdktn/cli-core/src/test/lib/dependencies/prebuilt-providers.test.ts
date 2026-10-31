// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  Dispatcher,
} from "undici";
import { OPENTOFU_REGISTRY, TERRAFORM_REGISTRY } from "@cdktn/commons";
import { ProviderConstraint } from "../../../lib/dependencies/dependency-manager";
import {
  getListedNpmPackageName,
  getNpmPackageName,
  getPrebuiltProviderVersions,
  getAllPrebuiltProviderVersions,
  getPrebuiltProviderRepositoryName,
  resetFetchCache,
} from "../../../lib/dependencies/prebuilt-providers";

function buildNpmResponse(
  version = "0.0.0",
  name = "test",
  cdktfVersion = "^0.12.2",
  hasRepository = true,
  useCdktn = false,
): any {
  return {
    versions: {
      [version]: {
        [useCdktn ? "cdktn" : "cdktf"]: {
          provider: {
            name: `registry.terraform.io/hashicorp/${name}`,
            version: "0.3.1",
          },
        },
        peerDependencies: {
          [useCdktn ? "cdktn" : "cdktf"]: cdktfVersion, // legacy providers still peerDepend on cdktf
        },
      },
    },
    repository:
      (hasRepository && {
        type: "git",
        url: useCdktn
          ? `git+https://github.com/cdktn-io/cdktn-provider-${name}.git`
          : `git+https://github.com/cdktf/cdktf-provider-${name}.git`,
      }) ||
      {},
  };
}

describe("prebuilt-providers", () => {
  const initialLogLevel = process.env.CDKTF_LOG_LEVEL;
  let originalDispatcher: Dispatcher;
  let mockAgent: MockAgent;

  beforeAll(() => {
    // Prevent logging outputs from polluting the test results
    process.env.CDKTF_LOG_LEVEL = "error";
  });

  afterAll(() => {
    process.env.CDKTF_LOG_LEVEL = initialLogLevel;
  });

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(() => {
    resetFetchCache();
    setGlobalDispatcher(originalDispatcher);
  });

  describe("getPrebuiltProviderRepositoryName", () => {
    it("reads the repository field", async () => {
      mockAgent
        .get("https://registry.npmjs.org")
        .intercept({ path: new RegExp("/@cdktf/.*"), method: "GET" })
        .reply(200, buildNpmResponse("2.3.0", "test1"));

      await expect(
        getPrebuiltProviderRepositoryName("@cdktf/provider-test1"),
      ).resolves.toEqual("github.com/cdktf/cdktf-provider-test1");
    });
  });

  describe("getPrebuiltProviderVersions", () => {
    it("fails when connection error", async () => {
      mockAgent
        .get("https://registry.npmjs.org")
        .intercept({ path: new RegExp("/@cdktf/.*"), method: "GET" })
        .replyWithError(
          Object.assign(new Error("connection error"), {
            code: "ETIMEDOUT",
          }),
        );

      await expect(
        getAllPrebuiltProviderVersions("@cdktf/test"),
      ).rejects.toThrow("Connection error");
    });

    it("fails when npm responds with 5xx", async () => {
      mockAgent
        .get("https://registry.npmjs.org")
        .intercept({ path: new RegExp("/@cdktf/.*"), method: "GET" })
        .reply(502, "Gateway error");

      await expect(
        getAllPrebuiltProviderVersions("@cdktf/test"),
      ).rejects.toThrow(/Unexpected error/);
    });

    it("fails when package doesn't exist", async () => {
      mockAgent
        .get("https://registry.npmjs.org")
        .intercept({ path: new RegExp("/@cdktf/.*"), method: "GET" })
        .reply(404, "Not found");

      await expect(
        getAllPrebuiltProviderVersions("@cdktf/test"),
      ).rejects.toThrow(/not found/i);
    });

    it("succeeds when package found", async () => {
      mockAgent
        .get("https://registry.npmjs.org")
        .intercept({ path: new RegExp("/@cdktf/.*"), method: "GET" })
        .reply(200, buildNpmResponse("2.3.0"));

      await expect(
        getAllPrebuiltProviderVersions("@cdktf/test"),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            packageVersion: "2.3.0",
          }),
        ]),
      );
    });

    it("returns using cache the second time", async () => {
      mockAgent
        .get("https://registry.npmjs.org")
        .intercept({ path: new RegExp("/@cdktf/.*"), method: "GET" })
        .reply(200, buildNpmResponse("2.4.2", "cachey"));

      await expect(
        getAllPrebuiltProviderVersions("@cdktf/cachey"),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            packageVersion: "2.4.2",
          }),
        ]),
      );

      // Since we're expecting the cache to respond, the actual URL can fail.
      // This interceptor must stay unconsumed — if it were hit, the reply(500)
      // would surface instead of the cached value.
      mockAgent
        .get("https://registry.npmjs.org")
        .intercept({ path: new RegExp("/@cdktf/.*"), method: "GET" })
        .reply(500, "");

      await expect(
        getAllPrebuiltProviderVersions("@cdktf/cachey"),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            packageVersion: "2.4.2",
          }),
        ]),
      );

      // ensure we never made the request: the reply(500) interceptor is still pending
      expect(mockAgent.pendingInterceptors().length).toBeGreaterThan(0);
    });

    it("succeeds when package cdktn found", async () => {
      mockAgent
        .get("https://registry.npmjs.org")
        .intercept({ path: new RegExp("/@cdktn/.*"), method: "GET" })
        .reply(200, buildNpmResponse("2.3.0", "test", "^0.12.2", true, true));

      await expect(
        getAllPrebuiltProviderVersions("@cdktn/test"),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            packageVersion: "2.3.0",
          }),
        ]),
      );
    });
  });

  describe("getPrebuiltProviderVersions across npm scopes", () => {
    const mockProvidersMap = () =>
      mockAgent
        .get("https://raw.githubusercontent.com")
        .intercept({
          path: /.*cdktn-repository-manager.*provider\.json/,
          method: "GET",
        })
        .reply(200, {
          awscc: "hashicorp/awscc@~> 1.0",
          googlebeta: "hashicorp/google-beta@~> 8.0",
        });
    const mockNpm = (path: string, status: number, body: any) =>
      mockAgent
        .get("https://registry.npmjs.org")
        .intercept({ path, method: "GET" })
        .reply(status, body);

    afterEach(() => {
      expect(mockAgent.pendingInterceptors()).toHaveLength(0);
    });

    it("returns the @cdktn versions when @cdktf has no package", async () => {
      mockProvidersMap();
      mockNpm("/@cdktf/provider-awscc", 404, "Not found");
      mockNpm(
        "/@cdktn/provider-awscc",
        200,
        buildNpmResponse("1.2.0", "awscc", "^0.12.2", true, true),
      );

      await expect(
        getPrebuiltProviderVersions(
          ProviderConstraint.fromConfigEntry("hashicorp/awscc"),
          "0.12.2",
        ),
      ).resolves.toEqual([{ name: "@cdktn/provider-awscc", version: "1.2.0" }]);
    });

    it("returns the @cdktf versions when @cdktn has no package", async () => {
      mockProvidersMap();
      mockNpm(
        "/@cdktf/provider-awscc",
        200,
        buildNpmResponse("0.9.0", "awscc"),
      );
      mockNpm("/@cdktn/provider-awscc", 404, "Not found");

      await expect(
        getPrebuiltProviderVersions(
          ProviderConstraint.fromConfigEntry("hashicorp/awscc"),
          "0.12.2",
        ),
      ).resolves.toEqual([{ name: "@cdktf/provider-awscc", version: "0.9.0" }]);
    });

    it("returns null when neither scope has a package", async () => {
      mockProvidersMap();
      mockNpm("/@cdktf/provider-awscc", 404, "Not found");
      mockNpm("/@cdktn/provider-awscc", 404, "Not found");

      await expect(
        getPrebuiltProviderVersions(
          ProviderConstraint.fromConfigEntry("hashicorp/awscc"),
          "0.12.2",
        ),
      ).resolves.toBeNull();
    });

    it("still fails when npm responds with 5xx", async () => {
      mockProvidersMap();
      mockNpm("/@cdktf/provider-awscc", 502, "Gateway error");

      await expect(
        getPrebuiltProviderVersions(
          ProviderConstraint.fromConfigEntry("hashicorp/awscc"),
          "0.12.2",
        ),
      ).rejects.toThrow(/Unexpected error/);
    });

    it("names packages after the provider rather than the map key", async () => {
      mockProvidersMap();
      mockNpm(
        "/@cdktf/provider-google-beta",
        200,
        buildNpmResponse("13.0.0", "google-beta"),
      );
      mockNpm(
        "/@cdktn/provider-google-beta",
        200,
        buildNpmResponse("14.0.0", "google-beta", "^0.12.2", true, true),
      );

      await expect(
        getPrebuiltProviderVersions(
          ProviderConstraint.fromConfigEntry("hashicorp/google-beta"),
          "0.12.2",
        ),
      ).resolves.toEqual([
        { name: "@cdktn/provider-google-beta", version: "14.0.0" },
        { name: "@cdktf/provider-google-beta", version: "13.0.0" },
      ]);
    });
  });

  describe("getListedNpmPackageName", () => {
    it.each([
      // C# (snake-cased from GoogleBeta) and Python dist names
      ["@cdktn/provider-google_beta", "@cdktn/provider-google-beta"],
      ["@cdktf/provider-google_beta", "@cdktf/provider-google-beta"],
      ["@cdktn/provider-opentelekomcloud", "@cdktn/provider-opentelekomcloud"],
    ])("resolves %s to %s", async (packageName, npmName) => {
      mockAgent
        .get("https://raw.githubusercontent.com")
        .intercept({
          path: /.*cdktn-repository-manager.*provider\.json/,
          method: "GET",
        })
        .reply(200, { googlebeta: "hashicorp/google-beta@~> 8.0" });

      await expect(getListedNpmPackageName(packageName)).resolves.toBe(npmName);
      expect(mockAgent.pendingInterceptors()).toHaveLength(0);
    });
  });

  describe("getNpmPackageName registry matching", () => {
    // Same shape as the published map: a constraint suffix, and some entries without a namespace.
    const mockProvidersMap = () =>
      mockAgent
        .get("https://raw.githubusercontent.com")
        .intercept({
          path: /.*cdktn-repository-manager.*provider\.json/,
          method: "GET",
        })
        .reply(200, {
          aws: "hashicorp/aws@~> 6.0",
          azurerm: "azurerm@~> 5.0",
          random: "hashicorp/random@~> 3.1",
        });

    it("finds the package for a Terraform-targeting project", async () => {
      mockProvidersMap();

      await expect(
        getNpmPackageName(
          new ProviderConstraint("random", "=3.9.0", TERRAFORM_REGISTRY),
          true,
        ),
      ).resolves.toBe("@cdktn/provider-random");
    });

    it("finds the package for an OpenTofu-only project", async () => {
      mockProvidersMap();

      await expect(
        getNpmPackageName(
          new ProviderConstraint("random", "=3.9.0", OPENTOFU_REGISTRY),
          true,
        ),
      ).resolves.toBe("@cdktn/provider-random");
    });

    it("matches an entry published without a namespace", async () => {
      mockProvidersMap();

      await expect(
        getNpmPackageName(
          new ProviderConstraint(
            "hashicorp/azurerm",
            "~> 5.0",
            OPENTOFU_REGISTRY,
          ),
          true,
        ),
      ).resolves.toBe("@cdktn/provider-azurerm");
    });

    it("fails when the providers map cannot be reached", async () => {
      mockAgent
        .get("https://raw.githubusercontent.com")
        .intercept({
          path: /.*cdktn-repository-manager.*provider\.json/,
          method: "GET",
        })
        .replyWithError(
          Object.assign(new Error("connection error"), { code: "ETIMEDOUT" }),
        );

      await expect(
        getNpmPackageName(
          new ProviderConstraint("random", "=3.9.0", TERRAFORM_REGISTRY),
          true,
        ),
      ).rejects.toThrow("Connection error");
    });

    it("does not match a private registry provider to a public prebuilt", async () => {
      mockProvidersMap();

      await expect(
        getNpmPackageName(
          new ProviderConstraint(
            "registry.example.com/hashicorp/random",
            "=3.9.0",
          ),
          true,
        ),
      ).resolves.toBeUndefined();
    });

    it("still reports no package for a provider that has none", async () => {
      mockProvidersMap();

      await expect(
        getNpmPackageName(
          new ProviderConstraint("nope", "=1.0.0", OPENTOFU_REGISTRY),
          true,
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe.skip("getPrebuiltProviderVersion", () => {
    it("returns null on connection error with github", async () => {
      mockAgent
        .get("https://www.cdk.tf")
        .intercept({
          path: "/.well-known/prebuilt-providers.json",
          method: "GET",
        })
        .replyWithError(
          Object.assign(new Error("connection error"), {
            code: "ETIMEDOUT",
          }),
        );

      await expect(
        getPrebuiltProviderVersions(
          ProviderConstraint.fromConfigEntry("test"),
          "0.12.2",
        ),
      ).rejects.toThrow("Connection error");
    });

    it("returns null on connection error with npm", async () => {
      mockAgent
        .get("https://www.cdk.tf")
        .intercept({
          path: "/.well-known/prebuilt-providers.json",
          method: "GET",
        })
        .reply(200, {
          test: "hashicorp/test@~> 0.3.3",
        });

      mockAgent
        .get("https://registry.npmjs.org")
        .intercept({ path: new RegExp("/@cdktf/.*"), method: "GET" })
        .replyWithError(
          Object.assign(new Error("connection error"), {
            code: "ETIMEDOUT",
          }),
        );

      await expect(
        getPrebuiltProviderVersions(
          ProviderConstraint.fromConfigEntry("test"),
          "0.12.2",
        ),
      ).rejects.toThrow("Connection error");
    });

    it("succeeds when both cdk.tf and npm work", async () => {
      mockAgent
        .get("https://www.cdk.tf")
        .intercept({
          path: "/.well-known/prebuilt-providers.json",
          method: "GET",
        })
        .reply(200, {
          test: "hashicorp/test@~> 0.3.3",
        });
      mockAgent
        .get("https://registry.npmjs.org")
        .intercept({ path: new RegExp("/@cdktf/.*"), method: "GET" })
        .reply(200, buildNpmResponse("2.3.0"));

      await expect(
        getPrebuiltProviderVersions(
          ProviderConstraint.fromConfigEntry("test"),
          "0.12.2",
        ),
      ).resolves.toEqual(["2.3.0"]);
    });
  });
});
