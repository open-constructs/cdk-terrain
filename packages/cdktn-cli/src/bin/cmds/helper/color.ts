// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

/**
 * Default for the `--no-color` flag. Colors are off when `FORCE_COLOR=0`, and
 * when stdout is not a terminal (pipe, file, CI log), since Terraform's own
 * escape codes are forwarded as-is otherwise. Any other `FORCE_COLOR` value
 * keeps color on for piped output.
 */
export function noColorDefault(
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY: boolean | undefined = process.stdout.isTTY,
): boolean {
  if (env.FORCE_COLOR === "0") {
    return true;
  }
  if (env.FORCE_COLOR) {
    return false;
  }
  return !stdoutIsTTY;
}
