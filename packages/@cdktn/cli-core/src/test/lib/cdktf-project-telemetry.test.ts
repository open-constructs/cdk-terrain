// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as Sentry from "@sentry/node";
import {
  IsErrorType,
  resetCommandTelemetry,
  seedTerraformCliProbeForTests,
  setUsageTelemetryEnabled,
} from "@cdktn/commons";
import { CdktfProject } from "../../lib/cdktf-project";
import { CdktfStack } from "../../lib/cdktf-stack";
import { SynthesizedStack } from "../../lib/synth-stack";

function synthesized(name: string, dependencies: string[] = []) {
  const metadata = { version: "0.21.0", stackName: name, backend: "s3" };
  const stack: SynthesizedStack = {
    name,
    dependencies,
    annotations: [],
    content: JSON.stringify({ "//": { metadata, outputs: {} } }),
    constructPath: ".",
    synthesizedStackPath: ".",
    workingDirectory: ".",
    stackMetadataPath: ".",
  };
  return stack;
}

// The executors and the reporting are real; only Terraform is replaced: its
// init rejects with `initFailure`, its runs for the stacks named in `failures`.
describe("CdktfProject stack telemetry", () => {
  let envelopeBodies: string[];
  let failures: Record<string, Error>;
  let initFailure: Error | undefined;
  const originalCheckpointDisable = process.env.CHECKPOINT_DISABLE;

  async function delivered(name: string) {
    expect(await Sentry.flush(2000)).toBe(true);
    return envelopeBodies
      .flatMap((body) => body.split("\n").filter(Boolean))
      .map((line) => JSON.parse(line))
      .flatMap((payload) => (Array.isArray(payload.items) ? payload.items : []))
      .filter((item) => item.name === name)
      .map((item) => ({
        value: item.value,
        command: item.attributes.command.value,
      }));
  }

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
    envelopeBodies = [];
    failures = {};
    initFailure = undefined;
    delete process.env.CHECKPOINT_DISABLE;
    setUsageTelemetryEnabled(true);
    seedTerraformCliProbeForTests(
      Promise.resolve("Terraform v1.9.0\non darwin_arm64\n"),
    );
    Sentry.init({
      dsn: "https://public@example.invalid/1",
      defaultIntegrations: false,
      transport: (options) =>
        Sentry.createTransport(options, async (request) => {
          envelopeBodies.push(request.body as string);
          return { statusCode: 200 };
        }),
    });

    jest
      .spyOn(CdktfStack.prototype, "initalizeTerraform")
      .mockImplementation(async () => {
        if (initFailure) {
          throw initFailure;
        }
        return undefined as any;
      });
    jest
      .spyOn(CdktfStack.prototype as any, "terraformClient")
      .mockImplementation(async function (this: CdktfStack) {
        const run = async () => {
          const failure = failures[this.stack.name];
          if (failure) {
            throw failure;
          }
          return { cancelled: false };
        };
        return {
          plan: run,
          deploy: run,
          destroy: run,
          output: async () => ({}),
        };
      });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    setUsageTelemetryEnabled(undefined);
    resetCommandTelemetry();
    seedTerraformCliProbeForTests();
    await Sentry.close(1000);
    if (originalCheckpointDisable !== undefined) {
      process.env.CHECKPOINT_DISABLE = originalCheckpointDisable;
    }
  });

  describe.each(["deploy", "destroy"] as const)("%s", (method) => {
    it("counts the stack whose run rejected, reports every stack of the run and rethrows that error", async () => {
      failures = { broken: new Error("terraform exited with 1") };
      const project = projectWith([synthesized("broken"), synthesized("fine")]);

      let thrown: unknown;
      await project[method]({
        skipSynth: true,
        autoApprove: true,
        stackNames: ["broken", "fine"],
      }).catch((e) => (thrown = e));

      expect(thrown).toBe(failures.broken);
      expect(await delivered("cli.stack")).toEqual([
        { value: 2, command: method },
      ]);
      expect(await delivered("cli.stack.failed")).toEqual([
        { value: 1, command: method },
      ]);
      expect(await delivered("cli.command.completed")).toEqual([]);
    });

    it("rethrows the Terraform error when the report itself fails", async () => {
      failures = { broken: new Error("terraform exited with 1") };
      const project = projectWith([synthesized("broken")]);
      jest
        .spyOn(project, "projectTelemetry")
        .mockRejectedValue(new Error("unreadable cdktf.json"));

      let thrown: unknown;
      await project[method]({
        skipSynth: true,
        autoApprove: true,
        stackNames: ["broken"],
      }).catch((e) => (thrown = e));

      expect(thrown).toBe(failures.broken);
    });

    it.each([
      {
        title: "waits its turn behind the one that rejected",
        stacks: [synthesized("first"), synthesized("second")],
        failing: "first",
        parallelism: 1,
      },
      {
        title: "depends on the one that rejected",
        stacks: [synthesized("base"), synthesized("dependant", ["base"])],
        failing: method === "deploy" ? "base" : "dependant",
        parallelism: undefined,
      },
    ])(
      "does not count as failed a stack that never ran because it $title",
      async ({ stacks, failing, parallelism }) => {
        failures = { [failing]: new Error("terraform exited with 1") };
        const project = projectWith(stacks);

        let thrown: unknown;
        await project[method]({
          skipSynth: true,
          autoApprove: true,
          stackNames: stacks.map((stack) => stack.name),
          parallelism,
        }).catch((e) => (thrown = e));

        expect(thrown).toBe(failures[failing]);
        expect(await delivered("cli.stack")).toEqual([
          { value: 2, command: method },
        ]);
        expect(await delivered("cli.stack.failed")).toEqual([
          { value: 1, command: method },
        ]);
        expect(await delivered("cli.command.completed")).toEqual([]);
      },
    );

    it("reports the stacks of a run whose init rejects, none of them failed, and rethrows that error", async () => {
      initFailure = new Error("terraform init exited with 1");
      const project = projectWith([
        synthesized("first"),
        synthesized("second"),
      ]);

      let thrown: unknown;
      await project[method]({
        skipSynth: true,
        autoApprove: true,
        stackNames: ["first", "second"],
      }).catch((e) => (thrown = e));

      expect(thrown).toBe(initFailure);
      expect(await delivered("cli.stack")).toEqual([
        { value: 2, command: method },
      ]);
      expect(await delivered("cli.stack.failed")).toEqual([]);
      expect(await delivered("cli.command.completed")).toEqual([]);
    });
  });

  describe("diff", () => {
    const stacks = [synthesized("other-stack"), synthesized("diffed-stack")];

    it("reports the diffed stack only and completes on a clean plan", async () => {
      await projectWith(stacks).diff({
        skipSynth: true,
        stackName: "diffed-stack",
      });

      expect(await delivered("cli.stack")).toEqual([
        { value: 1, command: "diff" },
      ]);
      expect(await delivered("cli.stack.failed")).toEqual([]);
      expect(await delivered("cli.command.completed")).toEqual([
        { value: 1, command: "diff" },
      ]);
    });

    it("counts the diffed stack as failed when the plan rejects and throws an external error carrying its stack trace", async () => {
      failures = { "diffed-stack": new Error("terraform exited with 1") };

      let thrown: unknown;
      await projectWith(stacks)
        .diff({ skipSynth: true, stackName: "diffed-stack" })
        .catch((e) => (thrown = e));

      expect(IsErrorType(thrown, "External")).toBe(true);
      expect((thrown as Error).message).toContain(
        "Stack failed to plan: diffed-stack",
      );
      expect((thrown as Error).stack).toBe(failures["diffed-stack"].stack);
      expect(await delivered("cli.stack")).toEqual([
        { value: 1, command: "diff" },
      ]);
      expect(await delivered("cli.stack.failed")).toEqual([
        { value: 1, command: "diff" },
      ]);
      expect(await delivered("cli.command.completed")).toEqual([]);
    });

    it("reports the diffed stack, not failed, when the init rejects and rethrows that error", async () => {
      initFailure = new Error("terraform init exited with 1");

      let thrown: unknown;
      await projectWith(stacks)
        .diff({ skipSynth: true, stackName: "diffed-stack" })
        .catch((e) => (thrown = e));

      expect(thrown).toBe(initFailure);
      expect(await delivered("cli.stack")).toEqual([
        { value: 1, command: "diff" },
      ]);
      expect(await delivered("cli.stack.failed")).toEqual([]);
      expect(await delivered("cli.command.completed")).toEqual([]);
    });
  });
});
