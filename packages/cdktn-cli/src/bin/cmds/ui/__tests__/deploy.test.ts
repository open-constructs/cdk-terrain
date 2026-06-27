// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
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

// Suppress noise from the StreamRenderer in unit tests.
jest.mock("../../helper/tty-stream", () => ({
  StreamRenderer: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(),
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
