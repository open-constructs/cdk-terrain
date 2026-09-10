// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { Errors } from "@cdktn/commons";
import { SynthStack } from "../../lib/synth-stack";

jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  sendTelemetry: jest.fn().mockResolvedValue(undefined),
  flushTelemetry: jest.fn().mockResolvedValue(undefined),
}));

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
    Errors.setScope("unknown");
  });

  it.each([
    ["the app exits non-zero", 'node -e "process.exit(1)"'],
    ["the app never writes a manifest", 'node -e ""'],
  ])(
    "emits one cli.command.error under the running command, flushes, then exits 1 when %s",
    async (_case, app) => {
      // a deploy's synth: the deploy is the run that failed
      Errors.setScope("deploy");
      await expect(
        SynthStack.synth(new AbortController().signal, app, outdir),
      ).rejects.toThrow("exit 1");

      expect(commons.sendTelemetry).toHaveBeenCalledTimes(1);
      expect(commons.sendTelemetry).toHaveBeenCalledWith("deploy", {
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
