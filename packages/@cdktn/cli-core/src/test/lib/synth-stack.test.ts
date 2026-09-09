// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { SynthStack, SynthesizedStack } from "../../lib/synth-stack";

jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  sendTelemetry: jest.fn().mockResolvedValue(undefined),
  flushTelemetry: jest.fn().mockResolvedValue(undefined),
}));

function stack(content: string): SynthesizedStack {
  return {
    name: "stack",
    dependencies: [],
    annotations: [],
    content,
    constructPath: ".",
    synthesizedStackPath: ".",
    workingDirectory: ".",
    stackMetadataPath: ".",
  };
}

describe("SynthStack.telemetryPayload", () => {
  // not the privacy boundary: the payload still carries the stack name and
  // the ids inside imports/moved; sendStackTelemetry reduces it to counts
  it("extracts the metadata block and required providers per stack", () => {
    const metadata = {
      version: "0.21.0",
      stackName: "prod-vpc",
      backend: "local",
    };
    const requiredProviders = { aws: { source: "aws", version: "~> 5.0" } };
    const payload = SynthStack.telemetryPayload([
      stack(
        JSON.stringify({
          "//": { metadata, outputs: {} },
          terraform: { required_providers: requiredProviders },
          resource: { aws_s3_bucket: { bucket: { bucket: "name" } } },
        }),
      ),
      // HCL output: the content is the metadata file, without a terraform block
      stack(JSON.stringify({ "//": { metadata, outputs: {} } })),
    ]);

    expect(payload).toEqual({
      stackMetadata: [metadata, metadata],
      requiredProviders: [requiredProviders, {}],
    });
    expect(payload.stackMetadata[0]).toHaveProperty("stackName");
    expect(JSON.stringify(payload)).not.toContain("aws_s3_bucket");
  });

  // content is read from disk on the failure path before the throw; it must
  // degrade to {} rather than take down deploy
  it("yields empty entries for content without metadata or unparsable content", () => {
    expect(
      SynthStack.telemetryPayload([stack("{}"), stack("not json")]),
    ).toEqual({
      stackMetadata: [{}, {}],
      requiredProviders: [{}, {}],
    });
  });
});

describe("SynthStack.synth failure paths count the run before exiting", () => {
  const commons = jest.requireMock("@cdktn/commons") as {
    sendTelemetry: jest.Mock;
    flushTelemetry: jest.Mock;
  };
  let outdir: string;
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    outdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-synth-stack-"));
    commons.sendTelemetry.mockClear();
    commons.flushTelemetry.mockClear();
    // a real exit would end jest; the sentinel stops synth where exit would
    exitSpy = jest.spyOn(process, "exit").mockImplementation(((
      code: number,
    ) => {
      throw new Error(`exit ${code}`);
    }) as never);
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    fs.removeSync(outdir);
  });

  it.each([
    ["the app exits non-zero", 'node -e "process.exit(1)"'],
    ["the app never writes a manifest", 'node -e ""'],
  ])(
    "emits one cli.command.error, flushes, then exits 1 when %s",
    async (_case, app) => {
      await expect(
        SynthStack.synth(new AbortController().signal, app, outdir),
      ).rejects.toThrow("exit 1");

      expect(commons.sendTelemetry).toHaveBeenCalledTimes(1);
      expect(commons.sendTelemetry).toHaveBeenCalledWith("synth", {
        error: true,
        errorType: "unexpected",
        synthOrigin: undefined,
      });
      expect(commons.flushTelemetry).toHaveBeenCalledTimes(1);
      expect(commons.sendTelemetry.mock.invocationCallOrder[0]).toBeLessThan(
        commons.flushTelemetry.mock.invocationCallOrder[0],
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    },
  );
});
