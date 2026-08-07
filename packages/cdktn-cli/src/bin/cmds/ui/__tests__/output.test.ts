// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import stripAnsi from "strip-ansi";

// Mock the project runner so we can drive a synthetic result without spawning a real CdktfProject.
// Unlike deploy.ts (which reads `project.outputsByConstructId` after the run), output.ts's
// `runOutput` gets its outputs from `runCdktfProject`'s `returnValue`, which is whatever the
// callback passed to `runCdktfProject` resolves to - here, `project.fetchOutputs(...)`.
const mockRunCdktfProject = jest.fn();
jest.mock("../../helper/project-runner", () => ({
  runCdktfProject: (opts: unknown, cb: unknown) =>
    mockRunCdktfProject(opts, cb),
}));

// Suppress noise from the StreamRenderer in unit tests, but keep a handle on `stop` so tests can
// assert it always runs regardless of which path (fatal save error / non-fatal render error) is hit.
const mockStreamStop = jest.fn();
jest.mock("../../helper/tty-stream", () => ({
  StreamRenderer: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: mockStreamStop,
    setBar: jest.fn(),
    clearBar: jest.fn(),
    appendLog: jest.fn(),
  })),
}));

// renderOutputs defaults to the real implementation; individual tests override it via
// mockRenderOutputs.mockImplementationOnce(...) to simulate a rendering failure.
const actualFormat = jest.requireActual("../../helper/format");
const mockRenderOutputs = jest.fn(actualFormat.renderOutputs);
jest.mock("../../helper/format", () => {
  const actual = jest.requireActual("../../helper/format");
  return {
    ...actual,
    renderOutputs: (...args: unknown[]) => mockRenderOutputs(...args),
  };
});

import { runOutput } from "../output";

const baseConfig = {
  outDir: "out",
  synthCommand: "noop",
  onOutputsRetrieved: () => {},
};

const outputsByConstructId = {
  db: { host: { sensitive: false, type: "string", value: "db.example.com" } },
};

beforeEach(() => {
  mockRunCdktfProject.mockReset();
  mockStreamStop.mockReset();
  mockRenderOutputs.mockReset();
  mockRenderOutputs.mockImplementation(actualFormat.renderOutputs);
  mockRunCdktfProject.mockImplementation(async () => ({
    returnValue: outputsByConstructId,
    project: {},
  }));
});

describe("runOutput --outputs-file write failures are fatal", () => {
  it("rejects with a clean Usage error when the write fails with ENOENT (bad path)", async () => {
    // Mirrors handlers.ts wiring: `onOutputsRetrieved` is `saveOutputs`, an async function. If this
    // call is not awaited, a rejection here becomes a floating, unhandled promise rejection instead
    // of something `runOutput` itself rejects with - this assertion (runOutput REJECTS) would fail
    // against code that doesn't await the call, since that code resolves normally instead.
    const err: NodeJS.ErrnoException = new Error(
      "ENOENT: no such file or directory, open '/missing-dir/out.json'",
    );
    err.code = "ENOENT";
    const onOutputsRetrieved = jest.fn().mockRejectedValue(err);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    let caught: any;
    try {
      await runOutput({
        ...baseConfig,
        onOutputsRetrieved,
        outputsPath: "/missing-dir/out.json",
      } as any);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught.__type).toBe("Usage");
    expect(caught.message).toContain("ENOENT: no such file or directory");
    // The fs error already names the path; the prefix must not repeat it.
    expect(caught.message).not.toContain("to /missing-dir/out.json:");
    expect(mockStreamStop).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it("rejects with a clean External error when the write fails with EACCES (permission denied)", async () => {
    const err: NodeJS.ErrnoException = new Error(
      "EACCES: permission denied, open '/missing-dir/out.json'",
    );
    err.code = "EACCES";
    const onOutputsRetrieved = jest.fn().mockRejectedValue(err);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    let caught: any;
    try {
      await runOutput({
        ...baseConfig,
        onOutputsRetrieved,
        outputsPath: "/missing-dir/out.json",
      } as any);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught.__type).toBe("External");
    expect(caught.message).toContain("EACCES: permission denied");

    logSpy.mockRestore();
  });

  it("does not print the 'written to' line when the write fails", async () => {
    const onOutputsRetrieved = jest.fn().mockRejectedValue(new Error("boom"));
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runOutput({
        ...baseConfig,
        onOutputsRetrieved,
        outputsPath: "/missing-dir/out.json",
      } as any),
    ).rejects.toBeDefined();

    const printed = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(printed).not.toContain("The outputs have been written to");

    logSpy.mockRestore();
  });

  it("still prints the outputs table before rejecting on a write failure", async () => {
    // The fetch succeeded and the outputs already exist in memory; only persistence failed. The
    // table must reach the user before the rejection, not be swallowed by the failing write.
    const onOutputsRetrieved = jest.fn().mockRejectedValue(new Error("boom"));
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runOutput({
        ...baseConfig,
        onOutputsRetrieved,
        outputsPath: "/missing-dir/out.json",
      } as any),
    ).rejects.toBeDefined();

    const printed = stripAnsi(
      logSpy.mock.calls.map((call) => call[0]).join("\n"),
    );
    expect(printed).toContain("host = db.example.com");

    logSpy.mockRestore();
  });

  it("resolves and prints the 'written to' line when the write succeeds", async () => {
    const onOutputsRetrieved = jest.fn().mockResolvedValue(undefined);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runOutput({
        ...baseConfig,
        onOutputsRetrieved,
        outputsPath: "/tmp/out.json",
      } as any),
    ).resolves.toBeUndefined();

    expect(onOutputsRetrieved).toHaveBeenCalledWith(outputsByConstructId);
    const printed = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(printed).toContain("The outputs have been written to /tmp/out.json");
    expect(mockStreamStop).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });
});

describe("runOutput output rendering is non-fatal", () => {
  it("does not fail the command when rendering the outputs throws", async () => {
    mockRenderOutputs.mockImplementationOnce(() => {
      throw new Error("render boom");
    });
    const onOutputsRetrieved = jest.fn();
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runOutput({ ...baseConfig, onOutputsRetrieved } as any),
    ).resolves.toBeUndefined();

    expect(onOutputsRetrieved).toHaveBeenCalledWith(outputsByConstructId);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Outputs fetched, but rendering them failed"),
    );
    expect(mockStreamStop).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
