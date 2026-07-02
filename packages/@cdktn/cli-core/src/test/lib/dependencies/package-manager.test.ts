// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import nock from "nock";
import { Language } from "@cdktn/commons";
import { PackageManager } from "../../../lib/dependencies/package-manager";

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

    it("returns false on a non-200 response from Maven Central", async () => {
      nock(MAVEN_HOST).get(pomPath("0.2.64")).reply(503);

      await expect(
        manager.isNpmVersionAvailable(
          "com.hashicorp.cdktf-provider-random",
          "0.2.64",
        ),
      ).resolves.toBe(false);
    });
  });
});
