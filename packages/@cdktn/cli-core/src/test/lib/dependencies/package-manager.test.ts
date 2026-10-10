// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  Dispatcher,
} from "undici";
import { Language, exec, logger } from "@cdktn/commons";
import {
  PackageManager,
  detectNodePackageManager,
} from "../../../lib/dependencies/package-manager";

jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  exec: jest.fn(),
}));

function pkg(packageManager: string) {
  return JSON.stringify({ packageManager });
}

function projectWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "cdktn-pm-test-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

const MAVEN_HOST = "https://repo1.maven.org";
const GITHUB_HOST = "https://api.github.com";
const PYPI_HOST = "https://pypi.org";
const NUGET_HOST = "https://azuresearch-usnc.nuget.org";

describe("package-manager", () => {
  let originalDispatcher: Dispatcher;
  let mockAgent: MockAgent;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(() => {
    mockAgent.assertNoPendingInterceptors();
    setGlobalDispatcher(originalDispatcher);
  });

  describe("detectNodePackageManager", () => {
    it.each<[string, Record<string, string>, string]>([
      ["npm field", { "package.json": pkg("npm@10.9.0") }, "npm"],
      [
        "pnpm field over a conflicting lockfile",
        { "package.json": pkg("pnpm@11.5.2"), "yarn.lock": "" },
        "pnpm",
      ],
      ["yarn@1 field", { "package.json": pkg("yarn@1.22.22") }, "yarn"],
      [
        "yarn@4 field",
        { "package.json": pkg("yarn@4.5.0+sha512.abc") },
        "yarn-berry",
      ],
      ["pnpm-lock.yaml", { "pnpm-lock.yaml": "" }, "pnpm"],
      ["yarn.lock alone", { "yarn.lock": "" }, "yarn"],
      [
        "yarn.lock with .yarnrc.yml",
        { "yarn.lock": "", ".yarnrc.yml": "" },
        "yarn-berry",
      ],
      ["nothing", {}, "npm"],
    ])("%s => %s", (_, files, expected) => {
      expect(detectNodePackageManager(projectWith(files))).toBe(expected);
    });
  });

  describe("NodePackageManager", () => {
    const execMock = exec as jest.MockedFunction<typeof exec>;

    beforeEach(() => {
      execMock.mockReset();
      jest.spyOn(console, "log").mockImplementation(() => undefined);
      jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it.each<[string, Record<string, string>, string, string[]]>([
      [
        "npm",
        {},
        "npm",
        [
          "install",
          "@cdktn/provider-random@1.0.0",
          "--silent",
          "--no-progress",
          "-E",
        ],
      ],
      [
        "pnpm",
        { "pnpm-lock.yaml": "" },
        "pnpm",
        ["add", "@cdktn/provider-random@1.0.0", "--silent", "-E"],
      ],
      [
        "yarn classic",
        { "yarn.lock": "" },
        "yarn",
        [
          "add",
          "@cdktn/provider-random@1.0.0",
          "--silent",
          "--no-progress",
          "-E",
        ],
      ],
      [
        "yarn berry",
        { "package.json": pkg("yarn@4.5.0") },
        "yarn",
        ["add", "@cdktn/provider-random@1.0.0", "-E"],
      ],
    ])(
      "adds a package quietly with flags %s accepts",
      async (_, files, command, args) => {
        const dir = projectWith(files);
        execMock.mockResolvedValue("");

        await PackageManager.forLanguage(Language.TYPESCRIPT, dir).addPackage(
          "@cdktn/provider-random",
          "1.0.0",
          true,
        );

        expect(execMock).toHaveBeenCalledWith(command, args, { cwd: dir });
      },
    );

    it("lists direct provider dependencies from pnpm", async () => {
      execMock.mockResolvedValue(
        JSON.stringify([
          {
            name: "my-project",
            dependencies: {
              "@cdktn/provider-random": { version: "3.0.11" },
              cdktn: { version: "0.22.0" },
            },
            devDependencies: {
              "@cdktf/provider-null": { version: "10.0.0" },
            },
          },
        ]),
      );

      const packages = await PackageManager.forLanguage(
        Language.TYPESCRIPT,
        projectWith({ "pnpm-lock.yaml": "" }),
      ).listProviderPackages();

      expect(packages).toEqual([
        { name: "@cdktn/provider-random", version: "3.0.11" },
        { name: "@cdktf/provider-null", version: "10.0.0" },
      ]);
    });

    it("refuses to list providers for Yarn Berry, pointing at the tracking issue", async () => {
      const manager = PackageManager.forLanguage(
        Language.TYPESCRIPT,
        projectWith({ "yarn.lock": "", ".yarnrc.yml": "" }),
      );

      await expect(manager.listProviderPackages()).rejects.toThrow(
        /not supported for projects using Yarn Berry.*issues\/492/,
      );
      expect(execMock).not.toHaveBeenCalled();
    });

    it("warns once per process that Yarn is deprecated or unsupported", async () => {
      await jest.isolateModulesAsync(async () => {
        const commons = await import("@cdktn/commons");
        const isolated =
          await import("../../../lib/dependencies/package-manager");
        (commons.exec as jest.Mock).mockResolvedValue("");
        const warn = jest
          .spyOn(commons.logger, "warn")
          .mockImplementation(() => undefined);

        const yarnProjects: Record<string, string>[] = [
          { "yarn.lock": "" },
          { "package.json": pkg("yarn@4.5.0") },
        ];
        for (const files of yarnProjects) {
          await isolated.PackageManager.forLanguage(
            Language.TYPESCRIPT,
            projectWith(files),
          ).addPackage("@cdktn/provider-random", "1.0.0");
        }

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain(
          isolated.YARN_TRACKING_ISSUE_URL,
        );
      });
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
      mockAgent
        .get(MAVEN_HOST)
        .intercept({ path: pomPath("0.2.64"), method: "GET" })
        .reply(200, "");

      await expect(
        manager.isNpmVersionAvailable(
          "com.hashicorp.cdktf-provider-random",
          "0.2.64",
        ),
      ).resolves.toBe(true);
    });

    it("returns false when the .pom is absent on Maven Central (HTTP 404)", async () => {
      mockAgent
        .get(MAVEN_HOST)
        .intercept({ path: pomPath("0.2.64"), method: "GET" })
        .reply(404, "");

      await expect(
        manager.isNpmVersionAvailable(
          "com.hashicorp.cdktf-provider-random",
          "0.2.64",
        ),
      ).resolves.toBe(false);
    });

    it("throws (rather than reporting absent) when Maven Central stays unreachable", async () => {
      // A transient 5xx is retried; after all attempts fail we must abort, not report the version as missing.
      mockAgent
        .get(MAVEN_HOST)
        .intercept({ path: pomPath("0.2.64"), method: "GET" })
        .reply(503, "")
        .times(3);

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
      mockAgent
        .get(GITHUB_HOST)
        .intercept({ path: refPath("0.2.64"), method: "GET" })
        .reply(200, { ref: "refs/tags/random/v0.2.64" });

      await expect(manager.isNpmVersionAvailable(pkg, "0.2.64")).resolves.toBe(
        true,
      );
    });

    it("returns false when GitHub reports the tag missing (HTTP 404)", async () => {
      mockAgent
        .get(GITHUB_HOST)
        .intercept({ path: refPath("0.2.64"), method: "GET" })
        .reply(404, { message: "Not Found" });

      await expect(manager.isNpmVersionAvailable(pkg, "0.2.64")).resolves.toBe(
        false,
      );
    });

    it("throws on a rate-limit response instead of reading it as absent", async () => {
      // GitHub returns a JSON body on rate-limit, so the old missing-`ref` check mistook a 429 for "tag absent".
      // A 429 is transient: retried, then aborts.
      mockAgent
        .get(GITHUB_HOST)
        .intercept({ path: refPath("0.2.64"), method: "GET" })
        .reply(429, { message: "API rate limit exceeded" })
        .times(3);

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
      mockAgent
        .get(PYPI_HOST)
        .intercept({ path: jsonPath("0.2.64"), method: "GET" })
        .reply(200, { info: { version: "0.2.64" } });

      await expect(manager.isNpmVersionAvailable(pkg, "0.2.64")).resolves.toBe(
        true,
      );
    });

    it("returns false when PyPI reports the version missing (HTTP 404)", async () => {
      mockAgent
        .get(PYPI_HOST)
        .intercept({ path: jsonPath("0.2.64"), method: "GET" })
        .reply(404, {});

      await expect(manager.isNpmVersionAvailable(pkg, "0.2.64")).resolves.toBe(
        false,
      );
    });

    it("throws when PyPI stays unreachable rather than reporting absent", async () => {
      mockAgent
        .get(PYPI_HOST)
        .intercept({ path: jsonPath("0.2.64"), method: "GET" })
        .reply(502, "")
        .times(3);

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
      mockAgent
        .get(NUGET_HOST)
        .intercept({ path: "/query", method: "GET", query })
        .reply(200, {
          data: [{ id: pkg, versions: [{ version: "0.2.64" }] }],
        });

      await expect(manager.isNpmVersionAvailable(pkg, "0.2.64")).resolves.toBe(
        true,
      );
    });

    it("returns false when NuGet returns no matching package", async () => {
      mockAgent
        .get(NUGET_HOST)
        .intercept({ path: "/query", method: "GET", query })
        .reply(200, { data: [] });

      await expect(manager.isNpmVersionAvailable(pkg, "0.2.64")).resolves.toBe(
        false,
      );
    });

    it("throws when NuGet stays unreachable rather than reporting absent", async () => {
      mockAgent
        .get(NUGET_HOST)
        .intercept({ path: "/query", method: "GET", query })
        .reply(500, "")
        .times(3);

      await expect(
        manager.isNpmVersionAvailable(pkg, "0.2.64"),
      ).rejects.toThrow(/Could not reach the registry/);
    });
  });
});
