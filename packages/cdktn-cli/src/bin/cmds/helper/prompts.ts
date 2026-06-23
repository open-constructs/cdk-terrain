// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { select } from "@inquirer/prompts";

/**
 * Message attached to the Error thrown when an interactive prompt is invoked without a TTY. Exported so callers can
 * match against it via {@link isNonTtyError} and degrade gracefully.
 */
export const PROMPT_NEEDS_TTY =
  "Cannot prompt without a TTY. Re-run with --auto-approve, or in an interactive terminal.";

/**
 * Guard that throws {@link PROMPT_NEEDS_TTY} if stdout is not a TTY. Used at the top of every prompt function so
 * cli-core's approval flow fails fast (and cleanly) in CI / piped contexts.
 *
 * @throws {Error} With message {@link PROMPT_NEEDS_TTY}.
 */
function requireTty(): void {
  if (!process.stdout.isTTY) {
    throw new Error(PROMPT_NEEDS_TTY);
  }
}

/**
 * @param e - Value caught from a `try`/`catch` around a prompt call.
 * @returns `true` if the error originated from {@link requireTty}, meaning the caller should fall back to a
 * non-interactive code path (e.g. `status.stop()`) rather than propagating.
 */
export function isNonTtyError(e: unknown): boolean {
  return e instanceof Error && e.message === PROMPT_NEEDS_TTY;
}

/** Possible outcomes of the deploy/destroy approval menu. */
export type ApproveAnswer = "approve" | "dismiss" | "stop";

/**
 * Show an interactive arrow-key menu asking the user how to proceed with a stack that's pending approval.
 *
 * @param stackName - Name of the stack being approved; included in the prompt message so the user knows which one
 *                    they're acting on when multiple are in flight.
 * @returns The user's selection.
 * @throws {Error} With message {@link PROMPT_NEEDS_TTY} if stdout is not a TTY.
 */
export async function promptApprove(stackName: string): Promise<ApproveAnswer> {
  requireTty();
  return select<ApproveAnswer>({
    message: `Please review the diff output above for ${stackName}`,
    choices: [
      {
        name: "Approve",
        value: "approve",
        description: "Applies the changes outlined in the plan.",
      },
      {
        name: "Dismiss",
        value: "dismiss",
        description:
          "Does not apply the changes outlined in the plan. This will also prevent depending stacks from planning.",
      },
      {
        name: "Stop",
        value: "stop",
        description:
          "Does not apply the changes. Currently running stacks will be finished, but no new ones will be started.",
      },
    ],
  });
}

/** Possible outcomes of the Sentinel policy soft-fail override menu. */
export type OverrideAnswer = "override" | "reject";

/**
 * Show an interactive arrow-key menu asking the user whether to override a Sentinel policy check failure.
 *
 * @param stackName - Stack name with the soft-failed policy check.
 * @returns The user's selection.
 * @throws {Error} With message {@link PROMPT_NEEDS_TTY} if stdout is not a TTY.
 */
export async function promptOverride(
  stackName: string,
): Promise<OverrideAnswer> {
  requireTty();
  return select<OverrideAnswer>({
    message: `Please review the above failures for ${stackName}`,
    choices: [
      {
        name: "Override",
        value: "override",
        description: "Overrides the soft failed policy check",
      },
      {
        name: "Reject",
        value: "reject",
        description:
          "Does not override the failed policy check, and stops the operation",
      },
    ],
  });
}
