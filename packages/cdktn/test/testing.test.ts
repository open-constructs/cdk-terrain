// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { TerraformStack, TerraformResource, Testing } from "../src";

import { Aspects } from "../src/aspect";
import { IConstruct } from "constructs";
import { createTmpHelper } from "./helper/tmp";

const tmp = createTmpHelper();

class MyResource extends TerraformResource {}

it("Testing.synth() executes Aspects added to constructs", () => {
  const app = Testing.app();
  const stack = new TerraformStack(app, "MyStack");

  const StackAspect = { visit: jest.fn() };
  const ResourceAspect = {
    visit: jest.fn().mockImplementation((resource: IConstruct) => {
      const inferredStack = TerraformStack.of(resource);
      new MyResource(inferredStack, "Resource2", {
        terraformResourceType: "aws_bucket",
        terraformGeneratorMetadata: {
          providerName: "test-provider",
        },
      });
    }),
  };

  const resource = new MyResource(stack, "Resource1", {
    terraformResourceType: "aws_bucket",
    terraformGeneratorMetadata: {
      providerName: "test-provider",
    },
  });

  Aspects.of(stack).add(StackAspect);
  Aspects.of(resource).add(ResourceAspect);

  expect(() => Testing.synth(stack)).not.toThrow();

  expect(StackAspect.visit).toHaveBeenNthCalledWith(1, stack);
  expect(StackAspect.visit).toHaveBeenNthCalledWith(2, resource);
  expect(ResourceAspect.visit).toHaveBeenCalledWith(resource);

  expect(Testing.renderConstructTree(app)).toMatchInlineSnapshot(`
      "App
      └── MyStack (TerraformStack)
          ├── Resource1 (MyResource)
          └── Resource2 (MyResource)
      "
    `);
});

it("Testing.cleanup() removes the temp outdirs Testing created and keeps a caller's outdir", () => {
  const callerOutdir = tmp("testing-cleanup.test");
  Testing.app({ outdir: callerOutdir });
  const appOutdir = Testing.app().outdir;
  const synthOutdir = Testing.fullSynth(
    new TerraformStack(Testing.app(), "MyStack"),
  );
  expect([appOutdir, synthOutdir].filter(fs.existsSync)).toHaveLength(2);

  Testing.cleanup();

  expect([appOutdir, synthOutdir].filter(fs.existsSync)).toEqual([]);
  expect(fs.existsSync(callerOutdir)).toBe(true);
});

it("Testing removes its temp outdirs when a non-Jest process exits", () => {
  // The exit hook never fires inside Jest's sandboxed `process`, so run the built
  // library (lib/, built before tests by the nx test target) in a plain node process.
  const script = `
    const fs = require("fs");
    const { Testing, TerraformStack } = require(process.argv[1]);
    const outdirs = [
      Testing.app().outdir,
      Testing.fullSynth(new TerraformStack(Testing.app(), "MyStack")),
    ];
    process.stdout.write(JSON.stringify(outdirs.filter(fs.existsSync)));
  `;
  const createdOutdirs: string[] = JSON.parse(
    execFileSync(process.execPath, ["-e", script, path.join(__dirname, "..")], {
      encoding: "utf8",
    }),
  );

  expect(createdOutdirs).toHaveLength(2);
  expect(createdOutdirs.filter(fs.existsSync)).toEqual([]);
});
