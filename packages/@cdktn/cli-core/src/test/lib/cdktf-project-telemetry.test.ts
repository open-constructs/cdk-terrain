// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { IsErrorType } from "@cdktn/commons";
import { CdktfProject } from "../../lib/cdktf-project";
import { SynthesizedStack } from "../../lib/synth-stack";

jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  sendTelemetry: jest.fn().mockResolvedValue(undefined),
}));

const metadata = {
  version: "0.21.0",
  stackName: "pending-stack",
  backend: "s3",
};
const stack: SynthesizedStack = {
  name: "pending-stack",
  dependencies: [],
  annotations: [],
  content: JSON.stringify({ "//": { metadata, outputs: {} } }),
  constructPath: ".",
  synthesizedStackPath: ".",
  workingDirectory: ".",
  stackMetadataPath: ".",
};

describe("CdktfProject stack telemetry on failure", () => {
  const commons = jest.requireMock("@cdktn/commons") as {
    sendTelemetry: jest.Mock;
  };

  beforeEach(() => {
    commons.sendTelemetry.mockClear();
  });

  // A pending executor after `execute` returns is a stack that never ran
  // (its dependency failed); the stack metrics go out before the throw.
  it.each(["deploy", "destroy"] as const)(
    "%s with a pending stack counts it as failed and still throws",
    async (method) => {
      const project = new CdktfProject({
        synthCommand: "unused",
        outDir: "unused",
        onUpdate: () => {},
      });
      jest
        .spyOn(project as any, "readSynthesizedStacks")
        .mockResolvedValue([stack]);
      jest
        .spyOn(project, "getStackExecutor")
        .mockReturnValue({ isPending: true, stack } as any);
      jest.spyOn(project as any, "execute").mockResolvedValue(undefined);

      let thrown: unknown;
      await project[method]({ skipSynth: true, autoApprove: true }).catch(
        (e) => (thrown = e),
      );

      expect(IsErrorType(thrown, "External")).toBe(true);
      expect((thrown as Error).message).toContain(
        `Some stacks failed to ${method}: pending-stack`,
      );
      expect(commons.sendTelemetry).toHaveBeenCalledTimes(1);
      expect(commons.sendTelemetry).toHaveBeenCalledWith(
        method,
        expect.objectContaining({
          stackMetadata: [metadata],
          failedStackCount: 1,
        }),
      );
    },
  );
});
