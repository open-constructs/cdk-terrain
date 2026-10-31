// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { logger } from "@cdktn/commons";
import { CdktfProject } from "../../lib/cdktf-project";
import { CdktfStack } from "../../lib/cdktf-stack";
import { SynthesizedStack } from "../../lib/synth-stack";

function synthesized(name: string, dependencies: string[] = []) {
  const stack: SynthesizedStack = {
    name,
    dependencies,
    annotations: [],
    content: JSON.stringify({ "//": { metadata: {}, outputs: {} } }),
    constructPath: ".",
    synthesizedStackPath: ".",
    workingDirectory: ".",
    stackMetadataPath: ".",
  };
  return stack;
}

const tick = () => new Promise((r) => setTimeout(r, 10));

// The project and its stack executors are real; only Terraform is replaced:
// its runs reject for the stacks named in `failures` and take a while for
// the stacks named in `slow`.
describe("CdktfProject running several stacks", () => {
  let failures: Record<string, Error>;
  let slow: string[];

  function projectWith(stacks: SynthesizedStack[]) {
    const project = new CdktfProject({
      synthCommand: "unused",
      outDir: "unused",
      onUpdate: () => {},
    });
    jest
      .spyOn(project as any, "readSynthesizedStacks")
      .mockResolvedValue(stacks);
    return project;
  }

  beforeEach(() => {
    failures = {};
    slow = [];
    jest
      .spyOn(CdktfStack.prototype, "initalizeTerraform")
      .mockResolvedValue(undefined as any);
    jest
      .spyOn(CdktfStack.prototype as any, "terraformClient")
      .mockImplementation(async function (this: CdktfStack) {
        const run = async () => {
          if (slow.includes(this.stack.name)) {
            await tick();
          }
          const failure = failures[this.stack.name];
          if (failure) {
            throw failure;
          }
          return { cancelled: false };
        };
        return { deploy: run, destroy: run, output: async () => ({}) };
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each(["deploy", "destroy"] as const)("%s", (method) => {
    it.each([
      {
        title: "another stack waits its turn behind it",
        stacks: [synthesized("first"), synthesized("second")],
        failing: "first",
        parallelism: 1,
      },
      {
        title: "the stack that needs it never starts",
        stacks: [synthesized("base"), synthesized("dependant", ["base"])],
        failing: method === "deploy" ? "base" : "dependant",
        parallelism: undefined,
      },
      {
        title: "another stack is still running",
        stacks: [synthesized("broken"), synthesized("busy")],
        failing: "broken",
        parallelism: 2,
        stillRunning: ["busy"],
      },
    ])(
      "rejects once with the error of a stack that fails while $title",
      async ({ stacks, failing, parallelism, stillRunning }) => {
        failures = { [failing]: new Error("terraform exited with 1") };
        slow = stillRunning ?? [];
        const project = projectWith(stacks);

        let thrown: unknown;
        await project[method]({
          skipSynth: true,
          autoApprove: true,
          stackNames: stacks.map((stack) => stack.name),
          parallelism,
        }).catch((e) => (thrown = e));

        expect(thrown).toBe(failures[failing]);
        // jest fails a test during which a rejection goes unhandled
        await tick();
      },
    );
  });

  // Terraform returns no outputs, so the output the stack declares is missing from state.
  it.each(["deploy", "fetchOutputs"] as const)(
    "names the stack and the missing output when %s finds a declared output absent from state",
    async (method) => {
      const warn = jest.spyOn(logger, "warn").mockImplementation(() => {});
      const web = synthesized("web");
      web.content = JSON.stringify({
        "//": { metadata: {}, outputs: { web: { site: { url: "site_url" } } } },
      });
      const project = projectWith([web]);

      await (method === "deploy"
        ? project.deploy({
            skipSynth: true,
            autoApprove: true,
            stackNames: ["web"],
          })
        : project.fetchOutputs({ skipSynth: true, stackNames: ["web"] }));

      expect(warn.mock.calls).toEqual([
        [
          '1 output declared by stack "web" was not returned by terraform and is omitted: web/site/url (site_url)',
        ],
      ]);
    },
  );
});
