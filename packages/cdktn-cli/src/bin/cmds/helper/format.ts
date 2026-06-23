// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import chalk from "chalk";
import Table from "cli-table3";
import {
  NestedTerraformOutputs,
  TerraformOutput,
  isTerraformOutput,
  CdktfStack,
  WatchState,
} from "@cdktn/cli-core";

const possibleColors = [
  "yellow",
  "blue",
  "cyan",
  "green",
  "white",
  "yellowBright",
  "blueBright",
  "cyanBright",
  "greenBright",
  "whiteBright",
] as const;

type ChalkColor = (typeof possibleColors)[number];

let colorPointer = 0;
const colorAssignments: Record<string, ChalkColor> = {};

/**
 * Assign (and remember) a colour for the given stack name. Colours are dispensed round-robin from
 * {@link possibleColors} so multiple concurrent stacks get distinct prefix colours that stay consistent for the
 * lifetime of the process.
 *
 * @param stackName - Stack identifier used as the cache key.
 * @returns A chalk colour name suitable for `chalk[color].bold(...)`.
 */
function getColor(stackName: string): ChalkColor {
  if (colorAssignments[stackName]) {
    return colorAssignments[stackName];
  }
  const color = possibleColors[colorPointer];
  colorPointer = (colorPointer + 1) % possibleColors.length;
  colorAssignments[stackName] = color;
  return color;
}

/**
 * Format a single log line with a coloured stack-name prefix.
 *
 * @param entry - The raw log entry.
 * @returns String of the form `<bold-coloured stackName>  <trimmed content>`, ready to write to stdout.
 */
export function formatLogLine(entry: {
  stackName: string;
  content: string;
}): string {
  const color = getColor(entry.stackName);
  const prefix = chalk[color].bold(entry.stackName);
  return `${prefix}  ${entry.content.trim()}`;
}

/**
 * Coerce a Terraform output value to a printable string. Objects are JSON-stringified with 2-space indent; everything
 * else goes through `String()`.
 *
 * @param value - The output value to render.
 * @returns A printable representation of the value.
 */
function sanitize(value: any): string {
  if (typeof value === "object") {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

/**
 * Build a comparator that sorts an outputs object so leaf outputs come before nested groups, then alphabetically
 * within each tier.
 *
 * @param value - The outputs object whose entries are being sorted.
 * @returns Comparator suitable for `Object.entries(...).sort(...)`.
 */
function compareOutputs(value: NestedTerraformOutputs) {
  return ([k1]: [string, any], [k2]: [string, any]): number => {
    if (isTerraformOutput(value[k1]) && isTerraformOutput(value[k2])) {
      return k1.localeCompare(k2);
    }
    if (isTerraformOutput(value[k1])) return -1;
    if (isTerraformOutput(value[k2])) return 1;
    return k1.localeCompare(k2);
  };
}

/**
 * Format a single leaf Terraform output. Sensitive outputs show `<sensitive>` instead of the value.
 *
 * @param name - Output name.
 * @param value - Output object from cli-core.
 * @returns A single-line string of the form `name = value`.
 */
function renderOutput(name: string, value: TerraformOutput): string {
  return `${name} = ${value.sensitive ? "<sensitive>" : sanitize(value.value)}`;
}

/**
 * Recursively render a (possibly nested) outputs node into indented text. Capped at 500 levels to bound runaway
 * recursion on pathological inputs.
 *
 * @param name - Key at the current node.
 * @param value - Either a leaf {@link TerraformOutput} or a nested group.
 * @param indent - Current indent depth (0 at the top level).
 * @returns Multi-line indented string; empty when depth exceeds the safety cap.
 */
function renderNested(
  name: string,
  value: NestedTerraformOutputs | TerraformOutput,
  indent: number,
): string {
  if (indent > 500) return "";
  if (isTerraformOutput(value)) {
    return " ".repeat(indent * 2) + renderOutput(name, value);
  }
  const header = " ".repeat(indent * 2) + chalk.bold(name);
  const children = Object.entries(value)
    .sort(compareOutputs(value))
    .map(([k, v]) => renderNested(k, v, indent + 1))
    .join("\n");
  return `${header}\n${children}`;
}

/**
 * Render a complete Terraform outputs tree as a printable block.
 *
 * @param outputs - The outputs map (typically `project.outputsByConstructId`).
 * @returns Multi-line string with leaf outputs first, nested groups indented, suitable for `console.log`. Empty string
 *          when there are no outputs.
 */
export function renderOutputs(outputs: NestedTerraformOutputs): string {
  return Object.entries(outputs)
    .map(([k, v]) => renderNested(k, v, 0))
    .join("\n");
}

/**
 * Render an array of `{ column: value }` rows as a cli-table3 bordered table. Column headers come from the keys of the
 * first row.
 *
 * @param data - Rows to render. Each row's value set must include all columns named in the first row's keys; missing
 * values render as the empty string.
 * @returns Multi-line table string ready to print. Empty string when `data` has no rows.
 */
export function renderProviderTable(
  data: Array<Record<string, string | number | boolean>>,
): string {
  if (data.length === 0) return "";
  const head = Object.keys(data[0]);
  const table = new Table({ head });
  for (const row of data) {
    table.push(head.map((col) => String(row[col] ?? "")));
  }
  return table.toString();
}

/**
 * Render a two-column "Stack name / Path" listing for `cdktn list`. Column width is sized to fit the longest stack
 * name.
 *
 * @param stacks - Stacks to list.
 * @returns Multi-line string with a bold header row followed by one row per stack.
 */
export function renderStackList(
  stacks: Array<{ name: string; workingDirectory: string }>,
): string {
  const nameWidth = Math.max(10, ...stacks.map((s) => s.name.length)) + 2;
  const header =
    chalk.bold("Stack name".padEnd(nameWidth)) + chalk.bold("Path");
  const rows = stacks.map((s) => s.name.padEnd(nameWidth) + s.workingDirectory);
  return [header, ...rows].join("\n");
}

/**
 * Pluralise "Stack" for English. `1 Stack` vs `N Stacks`.
 *
 * @param num - Count.
 * @returns Quantity + correctly-pluralised noun.
 */
function localizeStacks(num: number): string {
  return num === 1 ? "1 Stack" : `${num} Stacks`;
}

/**
 * Render the multi-stack progress line shown in the bottom bar during a deploy or destroy run: `<n Stacks deploying>
 * <n Stacks done>  <n Stacks * waiting>`.
 *
 * @param inProgress - Currently-running stacks.
 * @param finished - Completed stacks.
 * @param pending - Stacks queued behind in-progress ones.
 * @param actionName - Verb used in the first segment, matching the command.
 * @returns Single-line summary string.
 */
export function renderExecution(
  inProgress: CdktfStack[],
  finished: CdktfStack[],
  pending: CdktfStack[],
  actionName: "deploying" | "destroying",
): string {
  return (
    `${localizeStacks(inProgress.length)} ${actionName}     ` +
    `${localizeStacks(finished.length)} done     ` +
    `${localizeStacks(pending.length)} waiting`
  );
}

/**
 * Translate a cli-core watch state into bar text plus a spinner hint. The spinner is on for transient states (waiting
 * for changes, synthesising) and off when displaying the multi-stack execution counter or the terminal "stopped"
 * message — matching the old Ink-based watch UI.
 *
 * @param state - Watch state from cli-core.
 * @returns `{ text, spinner }` to pass through to {@link StreamRenderer.setBar | StreamRenderer's setBar}.
 */
export function renderWatchStatus(state: WatchState): {
  text: string;
  spinner: boolean;
} {
  switch (state.type) {
    case "waiting":
      return { text: "Waiting for changes...", spinner: true };
    case "stopped":
      return { text: "Watch was stopped", spinner: false };
    case "running": {
      if (
        state.inProgress.length +
          state.finished.length +
          state.pending.length ===
        0
      ) {
        return { text: "Synthesizing...", spinner: true };
      }
      return {
        text: renderExecution(
          state.inProgress,
          state.finished,
          state.pending,
          "deploying",
        ),
        spinner: false,
      };
    }
  }
}
