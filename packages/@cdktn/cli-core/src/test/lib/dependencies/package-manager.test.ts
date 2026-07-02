// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import nock from "nock";
import { Language } from "@cdktn/commons";
import { PackageManager } from "../../../lib/dependencies/package-manager";

const MAVEN_HOST = "https://repo1.maven.org";
const GITHUB_HOST = "https://api.github.com";
const PYPI_HOST = "https://pypi.org";
const NUGET_HOST = "https://azuresearch-usnc.nuget.org";

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

    it("throws (rather than reporting absent) when Maven Central stays unreachable", async () => {
      // A transient 5xx is retried; after all attempts fail we must abort, not report the version as missing.
      nock(MAVEN_HOST).get(pomPath("0.2.64")).times(3).reply(503);

      await expect(
        manager.isNpmVersionAvailable(
          "com.hashicorp.cdktf-provider-random",
          "0.2.64",
        ),
      ).rejects.toThrow(/Could not reach the registry/);
    });
  });

  describe("GoPackageManager.isNpmVersionAvailable", () => {
    let manager: PackageManager;
    const pkg = "github.com/cdktf/cdktf-provider-random-go/random";

    function refPath(version: string) {
      // Mirrors the GitHub tag-ref endpoint probed by GoPackageManager.isNpmVersionAvailable.
      return `/repos/cdktf/cdktf-provider-random-go/git/ref/tags/random/v${version}`;
    }

    beforeEach(() => {
      const dir = mkdtempSync(join(tmpdir(), "cdktn-pm-test-"));
      manager = PackageManager.forLanguage(Language.GO, dir);
    });

    it("returns true when GitHub returns the tag ref (HTTP 200)", async () => {
      nock(GITHUB_HOST)
        .get(refPath("0.2.64"))
        .reply(200, { ref: "refs/tags/random/v0.2.64" });

      await expect(manager.isNpmVersionAvailable(pkg, "0.2.64")).resolves.toBe(
        true,
      );
    });

    it("returns false when GitHub reports the tag missing (HTTP 404)", async () => {
      nock(GITHUB_HOST)
        .get(refPath("0.2.64"))
        .reply(404, { message: "Not Found" });

      await expect(manager.isNpmVersionAvailable(pkg, "0.2.64")).resolves.toBe(
        false,
      );
    });

    it("throws on a rate-limit response instead of reading it as absent", async () => {
      // GitHub returns a JSON body on rate-limit, so the old missing-`ref` check mistook a 429 for "tag absent".
      // A 429 is transient: retried, then aborts.
      nock(GITHUB_HOST)
        .get(refPath("0.2.64"))
        .times(3)
        .reply(429, { message: "API rate limit exceeded" });

      await expect(
        manager.isNpmVersionAvailable(pkg, "0.2.64"),
      ).rejects.toThrow(/Could not reach the registry/);
    });
  });

  describe("PythonPackageManager.isNpmVersionAvailable", () => {
    let manager: PackageManager;
    const pkg = "cdktf-cdktf-provider-random";

    function jsonPath(version: string) {
      return `/pypi/${pkg}/${version}/json`;
    }

    beforeEach(() => {
      const dir = mkdtempSync(join(tmpdir(), "cdktn-pm-test-"));
      manager = PackageManager.forLanguage(Language.PYTHON, dir);
    });

    it("returns true when PyPI has the version (info present)", async () => {
      nock(PYPI_HOST)
        .get(jsonPath("0.2.64"))
        .reply(200, { info: { version: "0.2.64" } });

      await expect(manager.isNpmVersionAvailable(pkg, "0.2.64")).resolves.toBe(
        true,
      );
    });

    it("returns false when PyPI reports the version missing (HTTP 404)", async () => {
      nock(PYPI_HOST).get(jsonPath("0.2.64")).reply(404, {});

      await expect(manager.isNpmVersionAvailable(pkg, "0.2.64")).resolves.toBe(
        false,
      );
    });

    it("throws when PyPI stays unreachable rather than reporting absent", async () => {
      nock(PYPI_HOST).get(jsonPath("0.2.64")).times(3).reply(502);

      await expect(
        manager.isNpmVersionAvailable(pkg, "0.2.64"),
      ).rejects.toThrow(/Could not reach the registry/);
    });
  });

  describe("NugetPackageManager.isNpmVersionAvailable", () => {
    let manager: PackageManager;
    const pkg = "HashiCorp.Cdktf.Providers.Random";
    const query = {
      q: "owner:HashiCorp id:Random",
      prerelease: "false",
      semVerLevel: "2.0.0",
    };

    beforeEach(() => {
      const dir = mkdtempSync(join(tmpdir(), "cdktn-pm-test-"));
      manager = PackageManager.forLanguage(Language.CSHARP, dir);
    });

    it("returns true when NuGet lists the version", async () => {
      nock(NUGET_HOST)
        .get("/query")
        .query(query)
        .reply(200, {
          data: [{ id: pkg, versions: [{ version: "0.2.64" }] }],
        });

      await expect(manager.isNpmVersionAvailable(pkg, "0.2.64")).resolves.toBe(
        true,
      );
    });

    it("returns false when NuGet returns no matching package", async () => {
      nock(NUGET_HOST).get("/query").query(query).reply(200, { data: [] });

      await expect(manager.isNpmVersionAvailable(pkg, "0.2.64")).resolves.toBe(
        false,
      );
    });

    it("throws when NuGet stays unreachable rather than reporting absent", async () => {
      nock(NUGET_HOST).get("/query").query(query).times(3).reply(500);

      await expect(
        manager.isNpmVersionAvailable(pkg, "0.2.64"),
      ).rejects.toThrow(/Could not reach the registry/);
    });
  });
});
