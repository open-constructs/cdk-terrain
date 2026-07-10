// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  Dispatcher,
} from "undici";
import { ProviderConstraint } from "../../../lib/dependencies/dependency-manager";
import {
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

  // TODO rebuild these tests when final url is known
  describe.skip("getNpmPackageName", () => {
    it("fails when connection error", async () => {
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
        getNpmPackageName(ProviderConstraint.fromConfigEntry("test"), false),
      ).rejects.toThrow("Connection error");
    });

    it("succeeds when cdk.tf redirect and Github work", async () => {
      mockAgent
        .get("https://www.cdk.tf")
        .intercept({
          path: "/.well-known/prebuilt-providers.json",
          method: "GET",
        })
        .reply(307, undefined, {
          headers: {
            Location:
              "https://raw.githubusercontent.com/cdktf/cdktf-repository-manager/main/provider.json",
          },
        });

      mockAgent
        .get("https://raw.githubusercontent.com")
        .intercept({
          path: "/cdktf/cdktf-repository-manager/main/provider.json",
          method: "GET",
        })
        .reply(200, {
          test: "hashicorp/test@~> 0.3.3",
        });

      await expect(
        getNpmPackageName(ProviderConstraint.fromConfigEntry("test"), false),
      ).resolves.toEqual("@cdktf/provider-test");
    });

    it("succeeds when cdk.tf directly returns result", async () => {
      mockAgent
        .get("https://www.cdk.tf")
        .intercept({
          path: "/.well-known/prebuilt-providers.json",
          method: "GET",
        })
        .reply(200, {
          test: "hashicorp/test@~> 0.3.3",
        });

      await expect(
        getNpmPackageName(ProviderConstraint.fromConfigEntry("test"), false),
      ).resolves.toEqual("@cdktf/provider-test");
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
