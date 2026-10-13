// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { NestedTerraformOutputs } from "@cdktn/cli-core";
import { renderOutputs } from "./format";

/**
 * Hand the fetched outputs to `onOutputsRetrieved` and print them. A failure to render is reported on stderr, prefixed
 * with `renderFailureLabel`, and does not throw: the command's real work has already succeeded.
 */
export function presentOutputs({
  outputs,
  onOutputsRetrieved,
  outputsPath,
  renderFailureLabel,
}: {
  outputs: NestedTerraformOutputs | undefined;
  onOutputsRetrieved: (outputs: NestedTerraformOutputs) => void;
  outputsPath?: string;
  renderFailureLabel: string;
}): void {
  onOutputsRetrieved(outputs as NestedTerraformOutputs);

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

  if (outputsPath) {
    console.log(`The outputs have been written to ${outputsPath}`);
  }
}
