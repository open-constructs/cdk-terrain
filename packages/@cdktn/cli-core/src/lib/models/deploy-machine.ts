/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  setup,
  createActor,
  sendTo,
  fromCallback,
  assign,
  EventObject,
  InspectionEvent,
} from "xstate";
import { Errors, logger } from "@cdktn/commons";
import { missingVariable } from "../errors";
import stripAnsi from "strip-ansi";
import { EOL } from "os";
import {
  spawnInteractive,
  InteractiveSpawnConfig,
} from "./interactive-process";

interface DeployContext {
  exitCode?: number;
  /**
   * Terraform will exit with 1 if it was cancelled, but we don't want to fail in that case
   */
  cancelled?: boolean;
}

export type DeployEvent =
  | { type: "START"; pty: InteractiveSpawnConfig }
  | { type: "STOP" }
  | { type: "SEND_LINE"; input: string }
  | { type: "OUTPUT_RECEIVED"; output: string }
  | { type: "APPROVED_EXTERNALLY" } // e.g. via TFC UI or API
  | { type: "REJECTED_EXTERNALLY" }
  | { type: "OVERRIDDEN_EXTERNALLY" }
  | { type: "OVERRIDE_REJECTED_EXTERNALLY" }
  | { type: "OVERRIDE" }
  | { type: "REJECT_OVERRIDE" }
  | { type: "REQUEST_APPROVAL" }
  | { type: "VARIABLE_MISSING"; variableName: string }
  | { type: "REQUEST_SENTINEL_OVERRIDE" }
  | { type: "APPROVE" }
  | { type: "REJECT" }
  | { type: "EXITED"; exitCode: number };

export function isDeployEvent<DeployEventType extends DeployEvent["type"]>(
  event: EventObject,
  type: DeployEventType,
): event is DeployEvent & { type: DeployEventType } {
  return event.type === type;
}

/**
 * Terraform's interactive prompt for a missing variable looks like:
 *
 *   var.<name>
 *     Enter a value:
 *
 * The variable name appears on its own line, prefixed with "var." (optionally
 * indented). We match this precisely so we don't mistake terraform error output
 * that merely references a variable (e.g. "92:   mirror = var.mirror" from an
 * "Unsupported argument" error) for an actual prompt. Terraform variable names
 * start with a letter or underscore and may contain letters, digits,
 * underscores and dashes. (#265)
 */
const VARIABLE_PROMPT_REGEX = /^\s*var\.([A-Za-z_][A-Za-z0-9_-]*)\s*$/;

/**
 * Returns true if any line in the given (ANSI-stripped) output is terraform's
 * interactive prompt for a missing variable.
 */
export function isMissingVariablePrompt(noColorLine: string): boolean {
  return noColorLine
    .split("\n")
    .some((line) => VARIABLE_PROMPT_REGEX.test(line));
}

export function extractVariableNameFromPrompt(line: string) {
  const noColorLine = stripAnsi(line);
  const lines = noColorLine.split("\n");
  const match = lines
    .map((l) => l.match(VARIABLE_PROMPT_REGEX))
    .find((m): m is RegExpMatchArray => m !== null);
  if (!match) {
    throw Errors.Internal(
      `Could not find variable name in prompt: ${line}. This is most likely a bug in cdktn. Please report it at http://cdktn.io/issues`,
    );
  }
  return match[1];
}

interface BufferedReceiverFunction {
  (output: string): void;
  /**
   * used to get the last buffer when the PTY exits to log a debug message if there's output left in there
   * (might help debugging on Windows if EOL from Nodejs doesn't work in WSL)
   */
  getBuffer: () => string;
}

// used to only send completed lines (= with a newline at the end of them) to our logic (#2827)
export function bufferUnterminatedLines(
  handler: (output: string) => void,
): BufferedReceiverFunction {
  let buffer = "";
  function bufferedReceiverFunction(output: string) {
    buffer += output;
    const lines = buffer.split(/[\n\r]+/);

    // if the string ends with \n this will be an empty string
    // else it will contain an "unfinished" line
    // the fallback to an empty string is to make TS happy and should never happen
    buffer = lines.pop() || "";

    if (lines.length > 0) handler(lines.join(EOL) + EOL);
  }
  bufferedReceiverFunction.getBuffer = () => buffer;

  return bufferedReceiverFunction;
}

export function handleLineReceived(send: (event: DeployEvent) => void) {
  return (output: string) => {
    let hideOutput = false;
    const noColorLine = stripAnsi(output);

    // possible events based on line
    if (noColorLine.includes("approved using the UI or API")) {
      send({ type: "APPROVED_EXTERNALLY" });
    } else if (noColorLine.includes("discarded using the UI or API")) {
      send({ type: "REJECTED_EXTERNALLY" });
    } else if (
      noColorLine.includes("Do you want to perform these actions") ||
      noColorLine.includes("Do you really want to destroy all resources?") ||
      noColorLine.includes(
        "Do you really want to destroy all resources in workspace",
      )
    ) {
      hideOutput = true;
      send({ type: "OUTPUT_RECEIVED", output });
      send({ type: "REQUEST_APPROVAL" });
    } else if (isMissingVariablePrompt(noColorLine)) {
      hideOutput = true;

      const variableName = extractVariableNameFromPrompt(output);
      send({
        type: "OUTPUT_RECEIVED",
        output: missingVariable(variableName),
      });
      send({ type: "VARIABLE_MISSING", variableName });
    } else if (noColorLine.includes("Enter a value:")) {
      // This comes along with above block, but is a separate line
      hideOutput = true;
    } else if (
      noColorLine.includes(
        "Do you want to override the soft failed policy check?",
      )
    ) {
      hideOutput = true;
      send({ type: "OUTPUT_RECEIVED", output });

      send({ type: "REQUEST_SENTINEL_OVERRIDE" });
    } else if (noColorLine.includes("overridden using the UI or API")) {
      send({ type: "OVERRIDDEN_EXTERNALLY" });
    }

    if (!hideOutput) {
      send({
        type: "OUTPUT_RECEIVED",
        output,
      });
    }
  };
}

/**
 * Input passed to the invoked pty actor, carrying the spawn config from the START event.
 */
export interface PtyActorInput {
  pty: InteractiveSpawnConfig;
}

/**
 * Builds the invoked actor that runs terraform in a pty. It relays completed lines back to the parent machine via
 * `sendBack` and forwards SEND_LINE events from the parent to the pty via `receive`. The `spawn` function is a
 * parameter so tests can inject a mock pty.
 */
export function makeTerraformPtyService(spawn = spawnInteractive) {
  return fromCallback<DeployEvent, PtyActorInput>(
    ({ sendBack, receive, input }) => {
      const { pty } = input;

      // Communication from the pty to the caller
      const receiver = bufferUnterminatedLines(handleLineReceived(sendBack));
      const { exitCode, actions } = spawn(pty, (data) => {
        receiver(data);
      });

      // Communication from the caller to the pty
      receive((event) => {
        if (event.type === "SEND_LINE") {
          actions.writeLine(event.input);
        }
      });

      exitCode.then((exitCode) => {
        const lastBuffer = receiver.getBuffer();
        if (lastBuffer.length > 0) {
          logger.debug(
            `Terraform CLI exited but the last outputted line was not terminated with a newline and hence is still in the buffer and wasn't printed: "${lastBuffer}"`,
          );
        }

        sendBack({ type: "EXITED", exitCode });
      });

      return () => {
        logger.trace("Terraform CLI state machine: cleaning up pty");
        actions.stop();
      };
    },
  );
}

export const terraformPtyService = makeTerraformPtyService();

export const deployMachine = setup({
  types: {
    context: {} as DeployContext,
    events: {} as DeployEvent,
  },
  actors: {
    runTerraformInPty: terraformPtyService,
  },
}).createMachine({
  context: {},
  initial: "idle",
  id: "root",
  states: {
    idle: {
      on: {
        START: { target: "running" },
      },
    },
    running: {
      invoke: {
        id: "pty",
        src: "runTerraformInPty",
        input: ({ event }) => {
          if (event.type !== "START") {
            throw Errors.Internal(
              `Terraform CLI invocation state machine: Unexpected event caused transition to the running state: ${event.type}`,
            );
          }
          return { pty: event.pty };
        },
      },
      on: {
        EXITED: "exited",
        STOP: ".stopping", // wait for terraform to exit, don't stop immediately (see the "stopping" state)
      },
      initial: "processing",
      states: {
        // TODO: what else might TF CLI be asking? Can we detect any question from the TF CLI to show a good error?
        processing: {
          on: {
            REQUEST_APPROVAL: "awaiting_approval",
            REQUEST_SENTINEL_OVERRIDE: "awaiting_sentinel_override",
            VARIABLE_MISSING: {
              // Send to self rather than raise() so consumers observing the actor via inspection still see this event.
              actions: sendTo(({ self }) => self, {
                type: "EXITED",
                exitCode: 1,
              }),
            },
          },
        },
        awaiting_approval: {
          on: {
            APPROVED_EXTERNALLY: "processing",
            REJECTED_EXTERNALLY: {
              target: "#root.exited",
              actions: assign({ cancelled: true }),
            },
            APPROVE: {
              target: "processing",
              actions: sendTo("pty", { type: "SEND_LINE", input: "yes" }),
            },
            REJECT: {
              target: "processing",
              actions: [
                sendTo("pty", { type: "SEND_LINE", input: "no" }),
                assign({ cancelled: true }),
              ],
            },
          },
        },
        awaiting_sentinel_override: {
          on: {
            OVERRIDDEN_EXTERNALLY: "processing",
            OVERRIDE_REJECTED_EXTERNALLY: {
              target: "#root.exited",
              actions: assign({ cancelled: true }),
            },
            // The external discard message posted by the Terraform UI is the same as during apply, so we capture it
            // and re-send a more specific event. Sent to self rather than raise() so consumers observing the actor
            // via inspection still see it.
            REJECTED_EXTERNALLY: {
              actions: sendTo(({ self }) => self, {
                type: "OVERRIDE_REJECTED_EXTERNALLY",
              }),
            },
            OVERRIDE: {
              target: "processing",
              actions: sendTo("pty", { type: "SEND_LINE", input: "override" }),
            },
            REJECT_OVERRIDE: {
              target: "processing",
              actions: [
                sendTo("pty", { type: "SEND_LINE", input: "no" }),
                assign({ cancelled: true }),
              ],
            },
          },
        },
        // On STOP, wait for terraform's own EXITED before reaching the final "stopped" state, so the run only
        // resolves once it has exited and released its lock. Don't re-signal it — it already got the interrupt via
        // the process group, and a second signal aborts its graceful shutdown.
        stopping: {
          entry: assign({ cancelled: true }),
          on: {
            EXITED: "#root.stopped",
          },
        },
      },
    },
    exited: { type: "final" },
    stopped: { type: "final" },
  },
});

/**
 * Callback invoked for every inspection event on the deploy actor. Consumers use it to observe both the events
 * flowing through the machine and each resulting snapshot.
 */
export type DeployInspectionHandler = (
  inspectionEvent: InspectionEvent,
) => void;

export function createAndStartDeployService(
  options: {
    refreshOnly?: boolean;
    parallelism: number;
    extraOptions: string[];
    terraformBinaryName: string;
    autoApprove?: boolean;
    noColor?: boolean;
    workdir: string;
    vars?: string[];
    varFiles?: string[];
  },
  inspect?: DeployInspectionHandler,
) {
  const service = createActor(deployMachine, { inspect });
  const args = [
    "apply",
    ...(options.autoApprove ? ["-auto-approve"] : []),
    // "-input=false", we can't use this anymore but TODO: we need to detect TF CLI asking for missing inputs and either allow passing them or stop there and fail

    ...options.extraOptions,
    ...(options.refreshOnly ? ["-refresh-only"] : []),
    ...(options.noColor ? ["-no-color"] : []),
    ...(options.parallelism > -1
      ? [`-parallelism=${options.parallelism}`]
      : []),
  ];

  options.vars?.forEach((v) => {
    args.push(`-var=${v}`);
  });

  options.varFiles?.forEach((v) => {
    args.push(`-var-file=${v}`);
  });

  logger.debug(
    `Executing ${options.terraformBinaryName} ${args.join(" ")} in ${
      options.workdir
    }`,
  );

  const config: InteractiveSpawnConfig = {
    file: options.terraformBinaryName,
    args,
    options: {
      cwd: options.workdir,
      env: process.env as { [key: string]: string }, // TODO: make this explicit and move to caller or whatever
    },
  };

  service.start();
  service.send({ type: "START", pty: config });

  return service;
}

export function createAndStartDestroyService(
  options: {
    parallelism: number;
    extraOptions: string[];
    terraformBinaryName: string;
    autoApprove?: boolean;
    noColor?: boolean;
    workdir: string;
    vars?: string[];
    varFiles?: string[];
  },
  inspect?: DeployInspectionHandler,
) {
  const service = createActor(deployMachine, { inspect });

  const args = [
    "destroy",
    ...(options.autoApprove ? ["-auto-approve"] : []),
    // "-input=false", we can't use this anymore but TODO: we need to detect TF CLI asking for missing inputs and either allow passing them or stop there and fail

    ...options.extraOptions,
    ...(options.noColor ? ["-no-color"] : []),
    ...(options.parallelism > -1
      ? [`-parallelism=${options.parallelism}`]
      : []),
  ];

  options.vars?.forEach((v) => {
    args.push(`-var=${v}`);
  });

  options.varFiles?.forEach((v) => {
    args.push(`-var-file=${v}`);
  });

  logger.debug(
    `Executing ${options.terraformBinaryName} ${args.join(" ")} in ${
      options.workdir
    }`,
  );

  const config: InteractiveSpawnConfig = {
    file: options.terraformBinaryName,
    args,
    options: {
      cwd: options.workdir,
      env: process.env as { [key: string]: string }, // TODO: make this explicit and move to caller or whatever
    },
  };

  service.start();
  service.send({ type: "START", pty: config });

  return service;
}
