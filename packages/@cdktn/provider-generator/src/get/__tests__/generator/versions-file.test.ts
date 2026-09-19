// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as path from "path";
import { Language, TerraformDependencyConstraint } from "@cdktn/commons";
import { ConstructsMaker, GetOptions } from "../../constructs-maker";
import { createTmpHelper } from "../util";

const tmp = createTmpHelper();

jest.setTimeout(600_000);
global.setImmediate =
  global.setImmediate ||
  ((fn: any, ...args: any[]) => global.setTimeout(fn, 0, ...args));

describe("versions.json file generation", () => {
  const languages = [Language.TYPESCRIPT, Language.PYTHON];

  const constraints: TerraformDependencyConstraint[] = [
    {
      fqn: "hashicorp/aws",
      name: "aws",
      source: "hashicorp/aws",
      version: "4.0.0",
    },
    {
      fqn: "hashicorp/random",
      name: "random",
      source: "hashicorp/random",
      version: "3.1.3",
    },
    {
      fqn: "kreuzwerker/docker",
      name: "docker",
      source: "kreuzwerker/docker",
      // OpenTofu rejects everything below 3.7.0 as unsigned; see #440.
      version: "3.9.0",
    },
  ];

  beforeAll(() => {});

  test.each(languages)(
    "generates a file for the %s language",
    async (language) => {
      const workdir = tmp("versions-file.test");

      const options: GetOptions = {
        codeMakerOutput: workdir,
        targetLanguage: language,
      };

      // Ignore warnings to pop up from the generate function
      process.env.NODE_OPTIONS = "--max-old-space-size=16384";
      const constructMaker = new ConstructsMaker(
        options,
        process.env.CDKTF_EXPERIMENTAL_PROVIDER_SCHEMA_CACHE_PATH,
      );

      await constructMaker.generate(constraints);

      const output = fs.readFileSync(
        path.join(workdir, "versions.json"),
        "utf-8",
      );
      // versions.json is keyed by fully qualified name, and the host is
      // whichever registry the fetching CLI used - terraform's or tofu's - so
      // assert on the provider part rather than pinning one registry.
      const keys = Object.keys(JSON.parse(output)).map((k) =>
        k.split("/").slice(1).join("/"),
      );
      expect(keys).toEqual(
        expect.arrayContaining(constraints.map((c) => c.fqn)),
      );
    },
  );
});
