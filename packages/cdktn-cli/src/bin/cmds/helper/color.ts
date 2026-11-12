// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import chalk from "chalk";

/**
 * Default for the `--no-color` flag. It follows chalk's own color detection
 * (`FORCE_COLOR`, `--color` / `--no-color`, `TERM`, and whether stdout is a
 * terminal), so Terraform's output, which is forwarded as-is, is plain
 * whenever the CLI's own output is.
 */
export function noColorDefault(): boolean {
  return !chalk.supportsColor;
}
