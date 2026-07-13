/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { createActor, fromCallback, getNextSnapshot } from "xstate";
import { spawnInteractive } from "../../lib/models/interactive-process";
import {
  deployMachine,
  DeployEvent,
  PtyActorInput,
  extractVariableNameFromPrompt,
  makeTerraformPtyService,
  handleLineReceived,
  bufferUnterminatedLines,
} from "../../lib/models/deploy-machine";
import { EOL } from "os";

describe("extractVariableNameFromPrompt", () => {
  it.each([
    [
      `content`,
      `var.content
        Enter a value:`,
    ],
    [
      `SCREAM_CASE`,
      `var.SCREAM_CASE
        Enter a value:`,
    ],
    [
      `nested_content_578CD0EA`,
      `var.nested_content_578CD0EA
          Enter a value:`,
    ],
    [
      `with-dashes`,
      `var.with-dashes
            Enter a value:`,
    ],
  ])(
    `should extract variable '%s' name from prompt '%s'`,
    (expected, prompt) => {
      expect(extractVariableNameFromPrompt(prompt)).toBe(expected);
    },
  );
});

describe("transitions", () => {
  it("reaches the running state after initial", async () => {
    const initialSnapshot = deployMachine.resolveState({
      value: "idle",
      context: {},
    });
    const actualState = getNextSnapshot(deployMachine, initialSnapshot, {
      type: "START",
      pty: { file: "", args: [], options: { cwd: "" } },
    });

    expect(actualState.matches("running")).toBe(true);
  });

  it("transitions to processing upon external approval", (done) => {
    const mockDeployMachine = deployMachine.provide({
      actors: {
        runTerraformInPty: fromCallback<DeployEvent, PtyActorInput>(
          ({ sendBack }) => {
            setTimeout(() => {
              sendBack({ type: "REQUEST_APPROVAL" });

              setTimeout(() => {
                sendBack({ type: "APPROVED_EXTERNALLY" });
              }, 100);
            }, 100);
          },
        ),
      },
    });

    // Observe events via inspection to assert the transition was caused by APPROVED_EXTERNALLY.
    let lastEvent: string | undefined;
    const ptyService = createActor(mockDeployMachine, {
      inspect: (inspectionEvent) => {
        if (
          inspectionEvent.type === "@xstate.event" &&
          inspectionEvent.actorRef === ptyService
        ) {
          lastEvent = inspectionEvent.event.type;
        }
      },
    });

    ptyService.subscribe((state) => {
      if (
        state.matches({ running: "processing" }) &&
        lastEvent === "APPROVED_EXTERNALLY"
      ) {
        done();
      }
    });

    ptyService.start();

    ptyService.send({
      type: "START",
      pty: {
        file: "",
        args: [],
        options: {
          cwd: "",
        },
      },
    });
  });
});

function mockPty(ptyEvents: string[]): typeof spawnInteractive {
  const actions = {
    write: jest.fn(),
    writeLine: jest.fn(),
    stop: jest.fn(),
  };
  return (_config: any, onData: (data: string) => void) => {
    ptyEvents.forEach((event, index) => {
      setTimeout(
        () => {
          onData(event);
        },
        100 * (index + 1),
      );
    });

    return {
      actions,
      progress: new Promise((resolve) => {
        setTimeout(() => resolve(""), ptyEvents.length * 200);
      }),
      exitCode: new Promise((resolve) => {
        setTimeout(() => resolve(0), ptyEvents.length * 200);
      }),
    };
  };
}

describe("pty events", () => {
  it("transitions when pty receives an approval question", (done) => {
    let isDone = false;
    const mockDeployMachine = deployMachine.provide({
      actors: {
        runTerraformInPty: makeTerraformPtyService(
          mockPty([`Do you want to perform these actions\nEnter a value:`]),
        ),
      },
    });

    const ptyService = createActor(mockDeployMachine);
    ptyService.subscribe((state) => {
      if (state.matches({ running: "awaiting_approval" }) && !isDone) {
        isDone = true;
        done();
      }
    });

    ptyService.start();

    ptyService.send({
      type: "START",
      pty: {
        file: "",
        args: [],
        options: {
          cwd: "",
        },
      },
    });
  });

  it("transitions when pty receives an approval question that is split across two buffers", (done) => {
    let isDone = false;
    const mockDeployMachine = deployMachine.provide({
      actors: {
        runTerraformInPty: makeTerraformPtyService(
          mockPty([`Do you want to per`, `form these actions\nEnter a value:`]),
        ),
      },
    });

    const ptyService = createActor(mockDeployMachine);
    ptyService.subscribe((state) => {
      if (state.matches({ running: "awaiting_approval" }) && !isDone) {
        isDone = true;
        done();
      }
    });

    ptyService.start();

    ptyService.send({
      type: "START",
      pty: {
        file: "",
        args: [],
        options: {
          cwd: "",
        },
      },
    });
  });

  it("transitions when pty receives an override question", (done) => {
    const mockDeployMachine = deployMachine.provide({
      actors: {
        runTerraformInPty: makeTerraformPtyService(
          mockPty([
            `Do you want to override the soft failed policy check?
          Only 'override' will be accepted to override.

          Enter a value:`,
          ]),
        ),
      },
    });

    const ptyService = createActor(mockDeployMachine);
    ptyService.subscribe((state) => {
      if (state.matches({ running: "awaiting_sentinel_override" })) {
        done();
      }
    });

    ptyService.start();

    ptyService.send({
      type: "START",
      pty: {
        file: "",
        args: [],
        options: {
          cwd: "",
        },
      },
    });
  });

  it("waits for terraform to exit on STOP rather than stopping immediately", (done) => {
    // The pty stays alive until we resolve its exit, letting us assert the machine waits for terraform's own exit
    // before reaching "stopped".
    const stop = jest.fn();
    let resolveExit: (code: number) => void = () => {};
    const controllablePty: typeof spawnInteractive = () => ({
      actions: { write: jest.fn(), writeLine: jest.fn(), stop },
      exitCode: new Promise<number>((resolve) => {
        resolveExit = resolve;
      }),
    });

    const mockDeployMachine = deployMachine.provide({
      actors: {
        runTerraformInPty: makeTerraformPtyService(controllablePty),
      },
    });

    let interrupted = false;
    const ptyService = createActor(mockDeployMachine);
    ptyService.subscribe((state) => {
      if (state.matches({ running: "stopping" }) && !interrupted) {
        interrupted = true;
        // We are waiting for terraform to exit, not yet at the final "stopped" state, and we have not re-signalled it.
        expect(state.matches("stopped")).toBe(false);
        expect(stop).not.toHaveBeenCalled();
        setTimeout(() => resolveExit(0), 50); // terraform finishes exiting, releasing its lock
      }

      if (state.matches("stopped")) {
        expect(state.context.cancelled).toBe(true);
        done();
      }
    });

    ptyService.start();

    ptyService.send({
      type: "START",
      pty: { file: "", args: [], options: { cwd: "" } },
    });

    // Give the pty service a tick to start before requesting a stop.
    setTimeout(() => ptyService.send({ type: "STOP" }), 50);
  });

  it("transitions to rejected state when done externally", (done) => {
    const mockDeployMachine = deployMachine.provide({
      actors: {
        runTerraformInPty: makeTerraformPtyService(
          mockPty([
            `Do you want to override the soft failed policy check?
          Only 'override' will be accepted to override.

          Enter a value:`,
            `discarded using the UI or API\n`,
          ]),
        ),
      },
    });

    // Record events seen by the machine via inspection.
    let enteredAwaiting = false;
    const states: string[] = [];
    const ptyService = createActor(mockDeployMachine, {
      inspect: (inspectionEvent) => {
        if (
          inspectionEvent.type === "@xstate.event" &&
          inspectionEvent.actorRef === ptyService
        ) {
          states.push(inspectionEvent.event.type);
        }
      },
    });

    ptyService.subscribe((state) => {
      if (enteredAwaiting && state.matches("exited")) {
        expect(states).toEqual(
          expect.arrayContaining(["OVERRIDE_REJECTED_EXTERNALLY"]),
        );
        done();
      }
      if (state.matches({ running: "awaiting_sentinel_override" })) {
        enteredAwaiting = true;
      }
    });

    ptyService.start();

    ptyService.send({
      type: "START",
      pty: {
        file: "",
        args: [],
        options: {
          cwd: "",
        },
      },
    });
  });
});

describe("handleLineReceived", () => {
  it("should forward the line", () => {
    const send = jest.fn();
    handleLineReceived(send)("foo");
    expect(send).toHaveBeenCalledWith({
      type: "OUTPUT_RECEIVED",
      output: "foo",
    });
  });

  it("should hide the line if a variable is missing", () => {
    const send = jest.fn();
    const input = `
        var.my_var
        Enter a value:
    `;
    handleLineReceived(send)(input);
    expect(send).not.toHaveBeenCalledWith({
      type: "OUTPUT_RECEIVED",
      output: input,
    });
    expect(send).toHaveBeenCalledWith({
      type: "VARIABLE_MISSING",
      variableName: "my_var",
    });
  });

  it("should not treat terraform error output referencing var. as a missing variable (#265)", () => {
    const send = jest.fn();
    const input = `
│ Error: Unsupported argument
│
│   on .terraform/modules/project/main.tf line 92, in resource "gitlab_project" "project":
│   92:   mirror                              = var.mirror
│
│ An argument named "mirror" is not expected here.
`;
    handleLineReceived(send)(input);
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "VARIABLE_MISSING" }),
    );
    // the real error output must still be forwarded to the user
    expect(send).toHaveBeenCalledWith({
      type: "OUTPUT_RECEIVED",
      output: input,
    });
  });

  it("should detect destroy all resources in workspace message on windows", () => {
    const send = jest.fn();
    const input = `\u001b[25
         l\u001b[m\n\u001b[1m\u001b[97mDo you really want to destroy all resources in workspace \\"windows-node-test\\"?   \u001b[2
    `;
    handleLineReceived(send)(input);
    expect(send).toHaveBeenCalledWith({
      type: "REQUEST_APPROVAL",
    });
  });
});

describe("bufferUnterminatedLines", () => {
  it.each(
    [
      {
        description: "should output the single terminated line",
        in: [`a${EOL}`],
        out: [`a${EOL}`],
      },
      {
        description: "should output the first and only terminated line",
        in: [`a${EOL}`, "b"],
        out: [`a${EOL}`],
      },
      {
        description: "should not output an unterminated line",
        in: ["a"],
        out: [],
      },
      {
        description: "should not output two unterminated lines",
        in: ["a", "b"],
        out: [],
      },
      {
        description: "should output the part that was terminated",
        in: [`a${EOL}b${EOL}c`],
        out: [`a${EOL}b${EOL}`],
      },
      {
        description:
          "should output everything after it that was terminated later",
        in: [`a${EOL}b${EOL}c`, EOL],
        out: [`a${EOL}b${EOL}`, `c${EOL}`],
      },
    ].map((testCase) => [testCase.description, testCase.in, testCase.out]),
  )("%s", (_desc, input, output) => {
    const realOutput: string[] = [];
    const handler = (str: string) => realOutput.push(str);
    const receiver = bufferUnterminatedLines(handler);
    input.forEach((i) => receiver(i));
    expect(realOutput).toEqual(output);
  });

  it("should return the current buffer", () => {
    const handler = jest.fn();
    const receiver = bufferUnterminatedLines(handler);
    receiver("Hi");
    expect(handler).not.toHaveBeenCalled();
    expect(receiver.getBuffer()).toBe("Hi");
  });
});
