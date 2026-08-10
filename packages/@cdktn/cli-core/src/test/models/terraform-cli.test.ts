// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TerraformCli, TerraformCliPlan } from "../../lib/models/terraform-cli";
import { spawnInteractive } from "../../lib/models/interactive-process";
import { SynthesizedStack } from "../../lib/synth-stack";
import { TerraformDeployState } from "../../lib/models/terraform";

jest.mock("../../lib/models/interactive-process");

// A pty that emits nothing and exits with the given code. Useful for exercising the state machine's lifecycle
// without a real terraform process.
function silentPty(exitCode: number): typeof spawnInteractive {
  return () => ({
    actions: { write: jest.fn(), writeLine: jest.fn(), stop: jest.fn() },
    exitCode: Promise.resolve(exitCode),
  });
}

function makeCli(): TerraformCli {
  const stack: SynthesizedStack = {
    name: "test",
    constructPath: "test",
    synthesizedStackPath: "",
    stackMetadataPath: "",
    workingDirectory: process.cwd(),
    annotations: [],
    dependencies: [],
    content: "{}",
  };
  const cli = new TerraformCli(new AbortController().signal, stack);
  // Avoid the network call setUserAgent() makes before spawning.
  jest.spyOn(cli, "setUserAgent").mockResolvedValue();
  return cli;
}

describe("terraform-cli", () => {
  describe("deploy", () => {
    it("reports running even when the process exits immediately", async () => {
      // Regression guard: the actor starts and receives START before handleService subscribes, so the initial
      // idle -> running transition must be replayed from the current snapshot. A silent, immediately-exiting
      // process has no later output to mask a missed callback.
      jest.mocked(spawnInteractive).mockImplementation(silentPty(0));

      const states: TerraformDeployState["type"][] = [];
      await makeCli().deploy({}, (state) => states.push(state.type));

      expect(states).toEqual(["running"]);
    });

    it("resolves without cancellation on a zero exit code", async () => {
      jest.mocked(spawnInteractive).mockImplementation(silentPty(0));

      await expect(makeCli().deploy({}, () => {})).resolves.toEqual({
        cancelled: false,
      });
    });

    it("rejects with the exit code on a non-zero exit", async () => {
      // The exit code is produced as the machine's final-state output and read off the settled snapshot.
      jest.mocked(spawnInteractive).mockImplementation(silentPty(3));

      await expect(makeCli().deploy({}, () => {})).rejects.toMatch(
        /exit code 3/,
      );
    });
  });

  describe("TerraformCliPlan", () => {
    it("#needsApply is false with no changes", () => {
      const plan = new TerraformCliPlan("./myplan", {
        resource_changes: [
          {
            address: "random_uuid.best-uuid",
            mode: "managed",
            type: "random_uuid",
            name: "best-uuid",
            provider_name: "registry.terraform.io/hashicorp/random",
            change: {
              actions: ["no-op"],
            },
          },
        ],
        output_changes: {
          uuid: {
            actions: ["no-op"],
            before: null,
          },
        },
      });
      expect(plan.needsApply).toBe(false);
    });

    it("#needsApply is true with only resource changes", () => {
      const plan = new TerraformCliPlan("./myplan", {
        resource_changes: [
          {
            address: "random_uuid.best-uuid",
            mode: "managed",
            type: "random_uuid",
            name: "best-uuid",
            provider_name: "registry.terraform.io/hashicorp/random",
            change: {
              actions: ["create"],
            },
          },
        ],
        output_changes: {
          uuid: {
            actions: ["no-op"],
            before: null,
          },
        },
      });

      expect(plan.needsApply).toBe(true);
    });

    it("#needsApply is true with only output changes", () => {
      const plan = new TerraformCliPlan("./myplan", {
        resource_changes: [
          {
            address: "random_uuid.best-uuid",
            mode: "managed",
            type: "random_uuid",
            name: "best-uuid",
            provider_name: "registry.terraform.io/hashicorp/random",
            change: {
              actions: ["no-op"],
            },
          },
        ],
        output_changes: {
          uuid: {
            actions: ["create"],
            before: null,
          },
        },
      });

      expect(plan.needsApply).toBe(true);
    });
  });
});
