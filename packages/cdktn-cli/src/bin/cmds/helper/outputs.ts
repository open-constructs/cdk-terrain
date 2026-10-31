// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Errors } from "@cdktn/commons";
import { NestedTerraformOutputs } from "@cdktn/cli-core";
import { renderOutputs } from "./format";

// A path that cannot name a file is the user's mistake; any other write failure is outside the CLI's control.
const usageErrorCodes = ["ENOENT", "ENOTDIR", "EISDIR", "ENAMETOOLONG"];

function outputsWriteError(e: unknown): Error {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  const typed =
    code && usageErrorCodes.includes(code) ? Errors.Usage : Errors.External;
  return typed(
    `Failed to write outputs: ${e instanceof Error ? e.message : e}`,
    e instanceof Error ? e : undefined,
  );
}

/**
 * Print the fetched outputs, then hand them to `onOutputsRetrieved`. A failure to render is reported on stderr,
 * prefixed with `renderFailureLabel`, and does not throw: the command's real work has already succeeded. A failure
 * of `onOutputsRetrieved` rejects with a Usage or External error.
 */
export async function presentOutputs({
  outputs,
  onOutputsRetrieved,
  outputsPath,
  renderFailureLabel,
}: {
  outputs: NestedTerraformOutputs | undefined;
  onOutputsRetrieved: (outputs: NestedTerraformOutputs) => void | Promise<void>;
  outputsPath?: string;
  renderFailureLabel: string;
}): Promise<void> {
  if (!outputs || Object.keys(outputs).length === 0) {
    console.log("No outputs found.");
  } else {
    try {
      console.log(renderOutputs(outputs));
    } catch (e) {
      console.error(
        `\n${renderFailureLabel}, but rendering the outputs failed: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
  }

  try {
    await onOutputsRetrieved(outputs as NestedTerraformOutputs);
  } catch (e) {
    throw outputsWriteError(e);
  }

  if (outputsPath) {
    console.log(`The outputs have been written to ${outputsPath}`);
  }
}
