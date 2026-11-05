// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  Language,
  ConstructsMakerModuleTarget,
  ConstructsMakerProviderTarget,
} from "@cdktn/commons";
import {
  ConstructsMaker,
  determineGoModuleName,
  pacmakArgs,
} from "../constructs-maker";

describe("constructsMaker", () => {
  describe("pacmakArgs", () => {
    const base = { entrypoint: "index.ts", deps: [], moduleKey: "test" };
    const golang = {
      outdir: ".",
      moduleName: "cdk.tf/test",
      packageName: "test",
    };

    it("disables runtime type checking when Go is the only target", () => {
      expect(pacmakArgs({ ...base, golang })).toEqual([
        "--code-only",
        "--no-runtime-type-checking",
      ]);
    });

    it("keeps runtime type checking for non-Go targets", () => {
      expect(
        pacmakArgs({ ...base, python: { outdir: ".", moduleName: "test" } }),
      ).toEqual(["--code-only"]);
    });

    it("keeps runtime type checking when Go is combined with another target", () => {
      expect(
        pacmakArgs({
          ...base,
          golang,
          csharp: { outdir: ".", namespace: "Test" },
        }),
      ).toEqual(["--code-only"]);
    });
  });

  describe("determineGoModuleName", () => {
    let tmpDir: string;
    let emptySubDir: string, validSubdir: string, invalidSubdir: string;

    beforeAll(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cdktf.test"));
      /* test directory layout
       * <tmpDir>
       * ├── go.mod
       * └── subdir
       *     ├── empty
       *     ├── valid
       *     │   └── go.mod
       *     └── invalid
       *         └── go.mod
       */
      emptySubDir = path.join(tmpDir, "subdir", "empty");
      validSubdir = path.join(tmpDir, "subdir", "valid");
      invalidSubdir = path.join(tmpDir, "subdir", "invalid");

      await fs.mkdirs(emptySubDir);
      await fs.mkdirs(validSubdir);
      await fs.mkdirs(invalidSubdir);

      const root = `module cdk.tf/test/go`;
      const valid = `module cdk.tf/test/go-valid-subdir`;
      const invalid = `malformed go mod`;

      await fs.writeFile(path.join(tmpDir, "go.mod"), root);
      await fs.writeFile(path.join(validSubdir, "go.mod"), valid);
      await fs.writeFile(path.join(invalidSubdir, "go.mod"), invalid);
    });

    afterAll(async () => {
      await fs.remove(tmpDir);
    });

    it("works in root directory", async () => {
      const moduleName = await determineGoModuleName(tmpDir);
      expect(moduleName).toBe("cdk.tf/test/go");
    });

    it("can walk upwards from empty directory", async () => {
      const moduleName = await determineGoModuleName(emptySubDir);
      expect(moduleName).toBe("cdk.tf/test/go/subdir/empty");
    });

    it("works in subdirectory with go.mod", async () => {
      const moduleName = await determineGoModuleName(validSubdir);
      expect(moduleName).toBe("cdk.tf/test/go-valid-subdir");
    });

    it("throws if go.mod is invalid", async () => {
      await expect(determineGoModuleName(invalidSubdir)).rejects.toThrow(
        `Could not determine the root Go module name. Found ${path.join(
          invalidSubdir,
          "go.mod",
        )} but failed to regex match the module name directive`,
      );
    });

    it("works from subdirectory that does not exist yet", async () => {
      const moduleName = await determineGoModuleName(
        path.join(tmpDir, "subdir", "that", "does", "not", "exist", "yet"),
      );
      expect(moduleName).toBe("cdk.tf/test/go/subdir/that/does/not/exist/yet");
    });

    it("throws if nothing could be found", async () => {
      const dir = "/cdktf-test/this/dir/does/not/exist"; //... and has no go.mod in any parent dir
      await expect(determineGoModuleName(dir)).rejects.toThrow(
        `Could not determine the root Go module name. No go.mod found in ${dir} and any parent directories`,
      );
    });
  });
  describe("ConstructsMakerProviderTarget", () => {
    it("returns valid package name for Go", () => {
      const target = new ConstructsMakerProviderTarget(
        {
          name: "google-beta",
          fqn: "google-beta",
          source: "google-beta",
          version: "~> 4.0",
        },
        Language.GO,
      );
      expect(target.srcMakName).toEqual("google_beta");
    });
  });
  describe("ConstructsMakerModuleTarget", () => {
    it("returns valid package name for Go", () => {
      const target = new ConstructsMakerModuleTarget(
        {
          name: "security-group",
          source: "terraform-aws-modules/security-group/aws",
          fqn: "terraform-aws-modules/security-group/aws",
          version: "4.9.0",
          namespace: "terraform-aws-modules/aws",
        },
        Language.GO,
      );
      expect(target.srcMakName).toEqual("security_group");
    });
  });

  describe("removeOrphanedResourceFolders", () => {
    let tmpDir: string;

    const providerDir = (provider: string) =>
      path.join(tmpDir, "providers", provider);

    /**
     * Lay out a provider folder containing the given resource directories plus
     * the provider-level index files a real generation run writes.
     */
    const seedProvider = async (provider: string, resources: string[]) => {
      for (const resource of resources) {
        await fs.mkdirs(path.join(providerDir(provider), resource));
        await fs.writeFile(
          path.join(providerDir(provider), resource, "index.ts"),
          "// generated\n",
        );
      }
      await fs.writeFile(
        path.join(providerDir(provider), "index.ts"),
        "// generated by cdktn get\n",
      );
      await fs.writeFile(
        path.join(providerDir(provider), "lazy-index.ts"),
        "// generated by cdktn get\n",
      );
    };

    const makeMaker = (targetLanguage: Language) =>
      new ConstructsMaker({
        codeMakerOutput: tmpDir,
        targetLanguage,
      });

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cdktf.orphans"));
    });

    afterEach(async () => {
      await fs.remove(tmpDir);
    });

    it("removes resource folders the current run did not emit", async () => {
      // 'teams' and 'data-lake-pipeline' exist only in the previously generated
      // provider version; the new schema no longer produces them.
      await seedProvider("mongodbatlas", [
        "cluster",
        "teams",
        "data-lake-pipeline",
      ]);

      const maker = makeMaker(Language.TYPESCRIPT);
      maker.emittedResourceFolders = { mongodbatlas: ["cluster"] };
      await maker.removeOrphanedResourceFolders();

      expect(
        await fs.pathExists(path.join(providerDir("mongodbatlas"), "cluster")),
      ).toBe(true);
      expect(
        await fs.pathExists(path.join(providerDir("mongodbatlas"), "teams")),
      ).toBe(false);
      expect(
        await fs.pathExists(
          path.join(providerDir("mongodbatlas"), "data-lake-pipeline"),
        ),
      ).toBe(false);
    });

    it("keeps provider-level files", async () => {
      await seedProvider("mongodbatlas", ["cluster", "teams"]);

      const maker = makeMaker(Language.TYPESCRIPT);
      maker.emittedResourceFolders = { mongodbatlas: ["cluster"] };
      await maker.removeOrphanedResourceFolders();

      expect(
        await fs.pathExists(path.join(providerDir("mongodbatlas"), "index.ts")),
      ).toBe(true);
      expect(
        await fs.pathExists(
          path.join(providerDir("mongodbatlas"), "lazy-index.ts"),
        ),
      ).toBe(true);
    });

    it("leaves providers that were not regenerated untouched", async () => {
      // filterAlreadyGenerated can skip a provider entirely, in which case it
      // has no entry in emittedResourceFolders and must not be pruned.
      await seedProvider("mongodbatlas", ["cluster"]);
      await seedProvider("onepassword", ["item"]);

      const maker = makeMaker(Language.TYPESCRIPT);
      maker.emittedResourceFolders = { mongodbatlas: ["cluster"] };
      await maker.removeOrphanedResourceFolders();

      expect(
        await fs.pathExists(path.join(providerDir("onepassword"), "item")),
      ).toBe(true);
    });

    it("is a no-op for non-TypeScript targets", async () => {
      // Other languages co-locate providers and modules, so a dropped resource
      // is indistinguishable from a hand-written construct.
      await seedProvider("mongodbatlas", ["cluster", "teams"]);

      const maker = makeMaker(Language.PYTHON);
      maker.emittedResourceFolders = { mongodbatlas: ["cluster"] };
      await maker.removeOrphanedResourceFolders();

      expect(
        await fs.pathExists(path.join(providerDir("mongodbatlas"), "teams")),
      ).toBe(true);
    });

    it("does not throw when the provider folder is missing", async () => {
      const maker = makeMaker(Language.TYPESCRIPT);
      maker.emittedResourceFolders = { mongodbatlas: ["cluster"] };

      await expect(
        maker.removeOrphanedResourceFolders(),
      ).resolves.not.toThrow();
    });
  });
});
