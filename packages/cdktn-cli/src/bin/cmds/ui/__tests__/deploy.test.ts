// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import stripAnsi from "strip-ansi";
import { logger } from "@cdktn/commons";
import { getConstructIdsForOutputs } from "@cdktn/cli-core/src/lib/output";
import { PROMPT_NEEDS_TTY } from "../../helper/prompts";

// Mock the prompts module so we can control what promptApprove / promptOverride throw.
const mockPromptApprove = jest.fn();
const mockPromptOverride = jest.fn();
jest.mock("../../helper/prompts", () => {
  const actual = jest.requireActual("../../helper/prompts");
  return {
    ...actual,
    promptApprove: (...args: unknown[]) => mockPromptApprove(...args),
    promptOverride: (...args: unknown[]) => mockPromptOverride(...args),
  };
});

// Mock the project runner so we can drive a synthetic status sequence without spawning a real CdktfProject.
type StatusHandler = (status: any) => void | Promise<void>;
const mockRunCdktfProject = jest.fn();
jest.mock("../../helper/project-runner", () => ({
  runCdktfProject: (opts: { onStatus: StatusHandler }, cb: any) =>
    mockRunCdktfProject(opts, cb),
}));

const mockStreamStop = jest.fn();
// Suppress noise from the StreamRenderer in unit tests.
jest.mock("../../helper/tty-stream", () => ({
  StreamRenderer: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: mockStreamStop,
    setBar: jest.fn(),
    clearBar: jest.fn(),
    appendLog: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
  })),
}));

import { runDeploy } from "../deploy";

const baseConfig = {
  outDir: "out",
  synthCommand: "noop",
  autoApprove: false,
  onOutputsRetrieved: () => {},
};

beforeEach(() => {
  mockPromptApprove.mockReset();
  mockPromptOverride.mockReset();
  mockRunCdktfProject.mockReset();
  mockStreamStop.mockReset();
});

describe("runDeploy approval routing", () => {
  it("routes a 'approve' answer to status.approve()", async () => {
    const approve = jest.fn();
    mockPromptApprove.mockResolvedValueOnce("approve");
    mockRunCdktfProject.mockImplementation(async (opts) => {
      await opts.onStatus({
        type: "waiting for approval of stack",
        stackName: "s",
        approve,
        dismiss: jest.fn(),
        stop: jest.fn(),
      });
      return {
        returnValue: undefined,
        project: { outputsByConstructId: {} },
      };
    });
    await runDeploy(baseConfig as any);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("routes a 'dismiss' answer to status.dismiss()", async () => {
    const dismiss = jest.fn();
    mockPromptApprove.mockResolvedValueOnce("dismiss");
    mockRunCdktfProject.mockImplementation(async (opts) => {
      await opts.onStatus({
        type: "waiting for approval of stack",
        stackName: "s",
        approve: jest.fn(),
        dismiss,
        stop: jest.fn(),
      });
      return {
        returnValue: undefined,
        project: { outputsByConstructId: {} },
      };
    });
    await runDeploy(baseConfig as any);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("calls status.stop() on PROMPT_NEEDS_TTY", async () => {
    const stop = jest.fn();
    mockPromptApprove.mockRejectedValueOnce(new Error(PROMPT_NEEDS_TTY));
    mockRunCdktfProject.mockImplementation(async (opts) => {
      await opts.onStatus({
        type: "waiting for approval of stack",
        stackName: "s",
        approve: jest.fn(),
        dismiss: jest.fn(),
        stop,
      });
      return {
        returnValue: undefined,
        project: { outputsByConstructId: {} },
      };
    });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await runDeploy(baseConfig as any);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("stdin is not a TTY"),
    );
    errSpy.mockRestore();
  });

  it("calls status.stop() on inquirer Exit/Abort/Cancel errors", async () => {
    const stop = jest.fn();
    // Shape any ExitPromptError-equivalent error (the catch matches by !isNonTtyError).
    const err = new Error("User force closed the prompt");
    err.name = "ExitPromptError";
    mockPromptApprove.mockRejectedValueOnce(err);
    mockRunCdktfProject.mockImplementation(async (opts) => {
      await opts.onStatus({
        type: "waiting for approval of stack",
        stackName: "s",
        approve: jest.fn(),
        dismiss: jest.fn(),
        stop,
      });
      return {
        returnValue: undefined,
        project: { outputsByConstructId: {} },
      };
    });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await runDeploy(baseConfig as any);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Approval prompt cancelled"),
    );
    errSpy.mockRestore();
  });
});

describe("runDeploy outputs", () => {
  const output = (value: string) => ({
    sensitive: false,
    type: "string",
    value,
  });
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  const printed = () => logSpy.mock.calls.map(([line]) => stripAnsi(line));

  const deployed = (outputsByConstructId: unknown) =>
    mockRunCdktfProject.mockResolvedValue({
      returnValue: undefined,
      project: { outputsByConstructId },
    });

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("presents the project's outputs by construct id", async () => {
    const outputsByConstructId = { db: { host: output("db.example.com") } };
    deployed(outputsByConstructId);
    let retrieved: unknown;

    await runDeploy({
      ...baseConfig,
      onOutputsRetrieved: (o: unknown) => (retrieved = o),
      outputsPath: "/tmp/out.json",
    } as any);

    expect(retrieved).toBe(outputsByConstructId);
    expect(printed()).toEqual([
      "db\n  host = db.example.com",
      "The outputs have been written to /tmp/out.json",
    ]);
  });

  it("reports a render failure as following a successful deploy", async () => {
    deployed({ db: { host: undefined } });

    await runDeploy(baseConfig as any);

    expect(errSpy.mock.calls).toEqual([
      [expect.stringContaining("Deploy succeeded, but rendering the outputs")],
    ]);
  });

  it("rejects when the outputs cannot be written, after stopping the stream", async () => {
    deployed({ db: { host: output("db.example.com") } });

    // Handled up front, so a dropped promise fails the assertion instead of crashing the test run.
    const write = Promise.reject(new Error("disk full"));
    write.catch(() => {});

    await expect(
      runDeploy({
        ...baseConfig,
        onOutputsRetrieved: () => write,
      } as any),
    ).rejects.toThrow("Failed to write outputs");

    expect(mockStreamStop).toHaveBeenCalled();
  });

  it("completes and prints the remaining outputs when terraform did not return a declared one", async () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      deployed(
        getConstructIdsForOutputs(
          "app",
          {
            "//": {
              outputs: {
                network: { ipv6: "ipv6_address", ipv4: "ipv4_address" },
                db: { host: "db_host" },
              },
            },
          },
          { ipv6_address: output("::1"), db_host: output("db.example.com") },
        ),
      );

      await runDeploy(baseConfig as any);

      expect(printed()).toEqual([
        "network\n  ipv6 = ::1\ndb\n  host = db.example.com",
      ]);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("runDeploy sentinel override routing", () => {
  it("routes an 'override' answer to status.override()", async () => {
    const override = jest.fn();
    mockPromptOverride.mockResolvedValueOnce("override");
    mockRunCdktfProject.mockImplementation(async (opts) => {
      await opts.onStatus({
        type: "waiting for override of sentinel policy check failure",
        stackName: "s",
        override,
        reject: jest.fn(),
      });
      return {
        returnValue: undefined,
        project: { outputsByConstructId: {} },
      };
    });
    await runDeploy(baseConfig as any);
    expect(override).toHaveBeenCalledTimes(1);
  });

  it("calls status.reject() when the override prompt is cancelled", async () => {
    const reject = jest.fn();
    const err = new Error("User force closed the prompt");
    err.name = "ExitPromptError";
    mockPromptOverride.mockRejectedValueOnce(err);
    mockRunCdktfProject.mockImplementation(async (opts) => {
      await opts.onStatus({
        type: "waiting for override of sentinel policy check failure",
        stackName: "s",
        override: jest.fn(),
        reject,
      });
      return {
        returnValue: undefined,
        project: { outputsByConstructId: {} },
      };
    });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await runDeploy(baseConfig as any);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Sentinel override prompt cancelled"),
    );
    errSpy.mockRestore();
  });
});
