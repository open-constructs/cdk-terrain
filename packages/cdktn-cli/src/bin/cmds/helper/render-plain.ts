/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { CdktfProject, ProjectUpdate } from "@cdktn/cli-core";
import { terraformCheck } from "./terraform-check";

/**
 * Shape of the `onLog` callback payload emitted by {@link CdktfProject}. Mirrored locally because cli-core does not
 * export the type, and matches the inline shape used by the ink hook in `ui/hooks/cdktf-project.ts`.
 */
type LogMessage = {
  /** Logical name of the stack the message originated from. Used as the per-line prefix. */
  stackName: string;
  /** Raw terraform output line, with no construct-path annotation. */
  message: string;
  /**
   * Same as `message`, but with the originating construct path appended. Preferred when present because it gives the
   * reader more context about which CDK construct produced the line.
   */
  messageWithConstructPath?: string;
};

/** Minimal options needed to construct a {@link CdktfProject} for non-interactive (plain-text) execution. */
export type RenderPlainOpts = {
  /** Directory containing the synthesized cdk.tf.json files (typically `cdktn.out`). */
  outDir: string;
  /** Shell command used to synthesize the app (e.g. `npx ts-node main.ts`). Read from `cdktn.json`. */
  synthCommand: string;
  /** When true, synthesize to HCL instead of JSON. Also honoured via the `SYNTH_HCL_OUTPUT` env var. */
  hcl?: boolean;
};

const PROMPT_NEEDS_TTY =
  "Interactive approval required but stdout is not a TTY. Pass --auto-approve to proceed non-interactively.";

/**
 * Run a {@link CdktfProject} task with plain `console.log` output instead of the ink TUI.
 *
 * Intended for use when stdout is not a TTY (redirected to a file, piped, or run under CI). Mirrors the wiring done by
 * the ink-based `useCdktfProject` hook — constructs a project with `onUpdate`/`onLog` callbacks and forwards SIGINT /
 * SIGTERM / SIGQUIT to `project.hardAbort()` — but writes each status/log event as a single line of plain text:
 *
 *   Synthesizing
 *   Synthesized
 *   <stackName>  <log line>
 *
 * Duplicate consecutive status updates are de-duped so long-running synth phases don't spam the output.
 *
 * Interactive prompts (`waiting for approval`, `waiting for sentinel override`) cannot be answered without a TTY and
 * therefore throw a usage error — callers should require `--auto-approve` before invoking this in non-TTY mode.
 *
 * @typeParam T              Return type of `projectCallback` — propagated so callers can extract e.g. terraform outputs.
 * @param opts               Project construction options (outDir, synthCommand, optional hcl flag).
 * @param projectCallback    Async function that drives the project (e.g. `(p) => p.diff(opts)`).
 * @returns                  Whatever `projectCallback` resolves to.
 * @throws                   If an interactive prompt is requested or if `projectCallback` rejects.
 */
export async function renderPlain<T>(
  opts: RenderPlainOpts,
  projectCallback: (project: CdktfProject) => Promise<T>,
): Promise<T> {
  await terraformCheck();

  let lastStatus: string | undefined;
  const announce = (status: string) => {
    if (lastStatus !== status) {
      lastStatus = status;
      console.log(status);
    }
  };

  const project = new CdktfProject({
    outDir: opts.outDir,
    hcl: opts.hcl,
    synthCommand: opts.synthCommand,
    onUpdate: (update: ProjectUpdate) => {
      switch (update.type) {
        case "synthesizing":
          announce("Synthesizing");
          break;
        case "synthesized":
          announce("Synthesized");
          break;
        case "waiting for approval":
        case "waiting for sentinel override":
          throw new Error(PROMPT_NEEDS_TTY);
      }
    },
    onLog: ({ stackName, message, messageWithConstructPath }: LogMessage) => {
      const content = (messageWithConstructPath ?? message).trimEnd();
      for (const line of content.split("\n")) {
        console.log(`${stackName}  ${line}`);
      }
    },
  });

  const onAbort = () => project.hardAbort();
  process.on("SIGINT", onAbort);
  process.on("SIGTERM", onAbort);
  process.on("SIGQUIT", onAbort);

  try {
    return await projectCallback(project);
  } finally {
    process.off("SIGINT", onAbort);
    process.off("SIGTERM", onAbort);
    process.off("SIGQUIT", onAbort);
  }
}

/**
 * Whether the current process's stdout is not connected to a TTY (i.e. redirected to a file, piped, or running under
 * a CI runner that captures output). Used to dispatch between the ink TUI and {@link renderPlain}.
 */
export function isNonInteractiveStdout(): boolean {
  return !process.stdout.isTTY;
}
