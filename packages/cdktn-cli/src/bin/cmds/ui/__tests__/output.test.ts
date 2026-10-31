// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import stripAnsi from "strip-ansi";

// Runs the project callback, so the outputs under test are the ones `fetchOutputs` resolved with.
const mockFetchOutputs = jest.fn();
jest.mock("../../helper/project-runner", () => ({
  runCdktfProject: async (
    _opts: unknown,
    projectCallback: (project: unknown) => Promise<unknown>,
  ) => ({
    returnValue: await projectCallback({ fetchOutputs: mockFetchOutputs }),
    project: {},
  }),
}));

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

import { runOutput } from "../output";

const baseConfig = {
  outDir: "out",
  synthCommand: "noop",
  onOutputsRetrieved: () => {},
};

describe("runOutput", () => {
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    mockFetchOutputs.mockReset();
    mockStreamStop.mockReset();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("presents the outputs it fetched", async () => {
    const fetched = {
      db: {
        host: { sensitive: false, type: "string", value: "db.example.com" },
      },
    };
    mockFetchOutputs.mockResolvedValue(fetched);
    let retrieved: unknown;

    await runOutput({
      ...baseConfig,
      onOutputsRetrieved: (o) => {
        retrieved = o;
      },
      outputsPath: "/tmp/out.json",
      targetStacks: ["db"],
      skipSynth: true,
      skipProviderLock: false,
    });

    expect(mockFetchOutputs).toHaveBeenCalledWith({
      stackNames: ["db"],
      skipSynth: true,
      skipProviderLock: false,
    });
    expect(retrieved).toBe(fetched);
    expect(logSpy.mock.calls.map(([line]) => stripAnsi(line))).toEqual([
      "db\n  host = db.example.com",
      "The outputs have been written to /tmp/out.json",
    ]);
  });

  it("reports a render failure as following a successful fetch", async () => {
    mockFetchOutputs.mockResolvedValue({ db: { host: undefined } });

    await runOutput(baseConfig);

    expect(errSpy.mock.calls).toEqual([
      [expect.stringContaining("Outputs fetched, but rendering the outputs")],
    ]);
  });

  it("rejects when the outputs cannot be written, after stopping the stream", async () => {
    mockFetchOutputs.mockResolvedValue({
      db: {
        host: { sensitive: false, type: "string", value: "db.example.com" },
      },
    });

    // Handled up front, so a dropped promise fails the assertion instead of crashing the test run.
    const write = Promise.reject(new Error("disk full"));
    write.catch(() => {});

    await expect(
      runOutput({
        ...baseConfig,
        onOutputsRetrieved: () => write,
      }),
    ).rejects.toThrow("Failed to write outputs");

    expect(mockStreamStop).toHaveBeenCalled();
  });
});
