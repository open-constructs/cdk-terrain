// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import nock from "nock";
import { Language } from "@cdktn/commons";
import {
  PackageManager,
  fetchWithRetry,
} from "../../../lib/dependencies/package-manager";

const MAVEN_HOST = "https://repo1.maven.org";

describe("package-manager", () => {
  beforeAll(() => {
    nock.disableNetConnect();
  });

  afterAll(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  afterEach(() => {
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });

  describe("fetchWithRetry", () => {
    const url = "https://example.com/data";
    const path = "/data";

    it("returns the parsed body on a successful response", async () => {
      nock("https://example.com").get(path).reply(200, { ok: true });

      await expect(fetchWithRetry(url)).resolves.toEqual({ ok: true });
    });

    it("retries transient 5xx responses then succeeds", async () => {
      nock("https://example.com")
        .get(path)
        .reply(503)
        .get(path)
        .reply(200, { ok: true });

      await expect(fetchWithRetry(url)).resolves.toEqual({ ok: true });
    });

    it("retries 429 (rate limited) responses", async () => {
      nock("https://example.com")
        .get(path)
        .reply(429)
        .get(path)
        .reply(200, { ok: true });

      await expect(fetchWithRetry(url)).resolves.toEqual({ ok: true });
    });

    it("does NOT retry a definitive 4xx response", async () => {
      // Only one mock is registered; a retry would attempt a second request and
      // fail nock's "no match" — so a passing test proves we did not retry.
      nock("https://example.com").get(path).reply(404);

      await expect(fetchWithRetry(url)).rejects.toThrow(/HTTP 404/);
    });

    it("throws after exhausting retries on persistent transient failures", async () => {
      nock("https://example.com").get(path).times(3).reply(503);

      await expect(fetchWithRetry(url, { attempts: 3 })).rejects.toThrow(
        /failed after 3 attempts/,
      );
    });

    it("retries network errors", async () => {
      nock("https://example.com")
        .get(path)
        .replyWithError("ECONNRESET")
        .get(path)
        .reply(200, { ok: true });

      await expect(fetchWithRetry(url)).resolves.toEqual({ ok: true });
    });
  });

  describe("JavaPackageManager.isNpmVersionAvailable", () => {
    let manager: PackageManager;

    function pomPath(version: string) {
      // Mirrors the CDN layout probed by JavaPackageManager.isNpmVersionAvailable:
      // groupId path / artifactId / version / artifactId-version.pom
      return `/maven2/com/hashicorp/cdktf-provider-random/${version}/cdktf-provider-random-${version}.pom`;
    }

    beforeEach(() => {
      // A bare temp dir (no build.gradle) resolves to the Maven manager.
      const dir = mkdtempSync(join(tmpdir(), "cdktn-pm-test-"));
      manager = PackageManager.forLanguage(Language.JAVA, dir);
    });

    it("returns true when the .pom exists on Maven Central (HTTP 200)", async () => {
      nock(MAVEN_HOST).get(pomPath("0.2.64")).reply(200);

      await expect(
        manager.isNpmVersionAvailable(
          "com.hashicorp.cdktf-provider-random",
          "0.2.64",
        ),
      ).resolves.toBe(true);
    });

    it("returns false when the .pom is absent on Maven Central (HTTP 404)", async () => {
      nock(MAVEN_HOST).get(pomPath("0.2.64")).reply(404);

      await expect(
        manager.isNpmVersionAvailable(
          "com.hashicorp.cdktf-provider-random",
          "0.2.64",
        ),
      ).resolves.toBe(false);
    });

    it("throws (rather than reporting absence) when Maven Central keeps failing", async () => {
      nock(MAVEN_HOST).get(pomPath("0.2.64")).times(3).reply(503);

      await expect(
        manager.isNpmVersionAvailable(
          "com.hashicorp.cdktf-provider-random",
          "0.2.64",
        ),
      ).rejects.toThrow(/failed after 3 attempts/);
    });
  });
});
