// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { CdktfProject, ProjectUpdate, CdktfStack } from "@cdktn/cli-core";
import { Errors } from "@cdktn/commons";

/**
 * High-level status of a running cdktn project, mapped from cli-core's `ProjectUpdate` events. The renderer/UI layer
 * reacts to these variants — showing a spinner, an execution counter, or an interactive prompt.
 */
export type Status =
  | { type: "starting" }
  | { type: "synthesizing" }
  | {
      type: "running";
      inProgress: CdktfStack[];
      finished: CdktfStack[];
      pending: CdktfStack[];
    }
  | {
      type: "waiting for approval of stack";
      stackName: string;
      approve: () => void;
      dismiss: () => void;
      stop: () => void;
    }
  | {
      type: "waiting for override of sentinel policy check failure";
      stackName: string;
      override: () => void;
      reject: () => void;
    }
  | { type: "done" };

/** A single log line emitted by cli-core, identified by the originating stack. */
export type LogEvent = {
  stackName: string;
  message: string;
  messageWithConstructPath?: string;
};

/** Configuration for {@link runCdktfProject}. */
export type ProjectRunnerOpts = {
  outDir: string;
  synthCommand: string;
  hcl?: boolean;
  /** Called whenever the project transitions to a new {@link Status}. */
  onStatus: (status: Status) => void | Promise<void>;
  /** Called for each log line the project emits. Receives raw cli-core events. */
  onLog?: (event: LogEvent) => void;
};

type Signal = "SIGINT" | "SIGTERM" | "SIGQUIT";
const signals: Signal[] = ["SIGINT", "SIGTERM", "SIGQUIT"];

/**
 * Construct a {@link CdktfProject}, wire its update/log callbacks to the caller's {@link Status} handler, install
 * signal handlers that trigger a hard abort, and run a project operation to completion.
 *
 * `onStatus` is invoked fire-and-forget from cli-core's synchronous update * callback; any rejection it produces is
 * not awaited. Callers wanting to `await` inside `onStatus` (e.g. for an interactive prompt) should manage their own
 * error handling there.
 *
 * @param opts - Project paths, output dir, and status/log callbacks.
 * @param projectCallback - The work to perform on the constructed project (e.g. `p => p.deploy(...)`, `p => p.synth()`).
 * @returns The project instance and the resolved value of `projectCallback`.
 * @throws Whatever `projectCallback` throws. SIGINT/SIGTERM/SIGQUIT trigger `project.hardAbort()` which typically
 * causes `projectCallback` to reject.
 */
export async function runCdktfProject<T>(
  opts: ProjectRunnerOpts,
  projectCallback: (project: CdktfProject) => Promise<T>,
): Promise<{ returnValue: T; project: CdktfProject }> {
  const runningStatus = (project: CdktfProject): Status => ({
    type: "running",
    inProgress: project.stacksToRun.filter((s) => s.isRunning),
    finished: project.stacksToRun.filter((s) => s.isDone),
    pending: project.stacksToRun.filter((s) => s.isPending),
  });

  // cli-core's onUpdate is sync, so onStatus is fire-and-forget. Wrap the promise with `.catch(() => {})` so any
  // rejection from the UI layer (an approval prompt the user cancelled, an inquirer Exit/Abort, etc.) doesn't
  // bubble up as an UnhandledPromiseRejection after we've already moved on.
  const fireStatus = (status: Status) => {
    void Promise.resolve(opts.onStatus(status)).catch(() => {});
  };

  const project = new CdktfProject({
    outDir: opts.outDir,
    hcl: opts.hcl,
    synthCommand: opts.synthCommand,
    onUpdate: (update: ProjectUpdate) => {
      if (update.type === "synthesizing") {
        fireStatus({ type: "synthesizing" });
      } else if (update.type === "waiting for approval") {
        fireStatus({
          type: "waiting for approval of stack",
          stackName: update.stackName,
          approve: update.approve,
          dismiss: update.dismiss,
          stop: update.stop,
        });
      } else if (update.type === "waiting for sentinel override") {
        fireStatus({
          type: "waiting for override of sentinel policy check failure",
          stackName: update.stackName,
          override: update.override,
          reject: update.reject,
        });
      } else {
        fireStatus(runningStatus(project));
      }
    },
    onLog: (event: LogEvent) => {
      opts.onLog?.(event);
      fireStatus(runningStatus(project));
    },
  });

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    project.hardAbort();
  };
  for (const sig of signals) process.on(sig, onAbort);

  try {
    fireStatus({ type: "starting" });
    const returnValue = await projectCallback(project);
    fireStatus({ type: "done" });
    return { returnValue, project };
  } catch (err) {
    // When the user hits Ctrl-C, our onAbort fires `project.hardAbort()`, which causes cli-core to reject with an
    // `AbortError`. That's expected — convert it into a clean exit so callers don't see Node's unhandled-rejection
    // banner. Non-abort failures (real terraform errors, etc.) propagate normally.
    if (aborted && isAbortError(err)) {
      throw Errors.Usage("Operation cancelled by user.");
    }
    throw err;
  } finally {
    for (const sig of signals) process.removeListener(sig, onAbort);
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      (err as { code?: string }).code === "ABORT_ERR")
  );
}
