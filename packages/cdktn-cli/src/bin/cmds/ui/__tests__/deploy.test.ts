// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import stripAnsi from "strip-ansi";
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
    pause: jest.fn(),
    resume: jest.fn(),
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
  mockRenderOutputs.mockReset();
  mockRenderOutputs.mockImplementation(actualFormat.renderOutputs);
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

describe("runDeploy output rendering", () => {
  it("prints without throwing for a two-stack outputsByConstructId containing an undefined leaf", async () => {
    // Regression case: a metadata-declared output that terraform did not return survives as an
    // `undefined` leaf inside one stack's nested outputs (mixed with resolved outputs), which
    // used to crash renderOutputs()/console.log() after both stacks had already deployed
    // successfully.
    const outputsByConstructId = {
      network: {
        ipv6_app_address: { sensitive: false, type: "string", value: "::1" },
        public_ipv4_address: undefined,
      },
      db: {
        host: { sensitive: false, type: "string", value: "db.example.com" },
        port: { sensitive: false, type: "string", value: "5432" },
      },
    };
    mockRunCdktfProject.mockImplementation(async () => ({
      returnValue: undefined,
      project: { outputsByConstructId },
    }));
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const onOutputsRetrieved = jest.fn();
    await expect(
      runDeploy({ ...baseConfig, onOutputsRetrieved } as any),
    ).resolves.not.toThrow();
    expect(onOutputsRetrieved).toHaveBeenCalledWith(outputsByConstructId);
    const printed = stripAnsi(
      logSpy.mock.calls.map((call) => call[0]).join("\n"),
    );
    expect(printed).toContain("ipv6_app_address = ::1");
    expect(printed).toContain("host = db.example.com");
    logSpy.mockRestore();
  });
});

describe("runDeploy output rendering when every declared output drops", () => {
  it("prints 'No outputs found.' instead of a stray blank line when the keys survive but renderOutputs collapses to an empty string", async () => {
    // outputsByConstructId still has a "network" key, but every output under it is an undefined
    // leaf (dropped upstream), so renderOutputs(outputs) returns "" even though
    // Object.keys(outputs).length > 0 - the regression case for the stray-blank-line bug.
    const outputsByConstructId = {
      network: {
        public_ipv4_address: undefined,
      },
    };
    mockRunCdktfProject.mockImplementation(async () => ({
      returnValue: undefined,
      project: { outputsByConstructId },
    }));
    const onOutputsRetrieved = jest.fn();
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runDeploy({ ...baseConfig, onOutputsRetrieved } as any),
    ).resolves.toBeUndefined();

    const printed = logSpy.mock.calls.map((call) => call[0]);
    expect(printed).toContain("No outputs found.");
    expect(printed).not.toContain("");

    logSpy.mockRestore();
  });
});

describe("runDeploy output rendering is non-fatal", () => {
  const outputsByConstructId = {
    db: { host: { sensitive: false, type: "string", value: "db.example.com" } },
  };

  beforeEach(() => {
    mockRunCdktfProject.mockImplementation(async () => ({
      returnValue: undefined,
      project: { outputsByConstructId },
    }));
  });

  it("does not fail the deploy when rendering the outputs throws", async () => {
    mockRenderOutputs.mockImplementationOnce(() => {
      throw new Error("render boom");
    });
    const onOutputsRetrieved = jest.fn();
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runDeploy({ ...baseConfig, onOutputsRetrieved } as any),
    ).resolves.toBeUndefined();

    expect(onOutputsRetrieved).toHaveBeenCalledWith(outputsByConstructId);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Deploy succeeded, but rendering the outputs failed",
      ),
    );
    expect(mockStreamStop).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("runDeploy --outputs-file write failures are fatal", () => {
  const outputsByConstructId = {
    db: { host: { sensitive: false, type: "string", value: "db.example.com" } },
  };

  beforeEach(() => {
    mockRunCdktfProject.mockImplementation(async () => ({
      returnValue: undefined,
      project: { outputsByConstructId },
    }));
  });

  it("rejects with a clean Usage error when the write fails with ENOENT (bad path)", async () => {
    // Mirrors handlers.ts wiring: `onOutputsRetrieved` is `saveOutputs`, an async function. If this
    // call is not awaited, a rejection here becomes a floating, unhandled promise rejection instead
    // of something `runDeploy` itself rejects with - this assertion (runDeploy REJECTS) would fail
    // against code that doesn't await the call, since that code resolves normally instead.
    const err: NodeJS.ErrnoException = new Error(
      "ENOENT: no such file or directory, open '/missing-dir/out.json'",
    );
    err.code = "ENOENT";
    const onOutputsRetrieved = jest.fn().mockRejectedValue(err);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    let caught: any;
    try {
      await runDeploy({
        ...baseConfig,
        onOutputsRetrieved,
        outputsPath: "/missing-dir/out.json",
      } as any);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    // A bad --outputs-file path is a usage mistake, not something outside our control: it must be
    // typed "Usage", not "External" (see cdktn.ts's `.fail()` handler: External/Usage errors print
    // just `error.message`, everything else prints message + stack + "Collecting Debug
    // Information..."; Usage errors are also excluded from Sentry crash reporting).
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
      await runDeploy({
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
      runDeploy({
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
    // The deploy succeeded and the outputs already exist in memory; only persistence failed. The
    // table must reach the user before the rejection, not be swallowed by the failing write.
    const onOutputsRetrieved = jest.fn().mockRejectedValue(new Error("boom"));
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runDeploy({
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
