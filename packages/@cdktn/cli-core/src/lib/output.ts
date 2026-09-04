// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as z from "zod";
import * as fs from "fs";
import * as path from "path";
import stripAnsi from "strip-ansi";

import { logger } from "@cdktn/commons";
import { ActionTypes, schema } from "./models/schema";
import {
  DeployingResource,
  DeployingResourceApplyState,
  PlannedResourceAction,
  TerraformOutput,
  isTerraformOutput,
} from "./models/terraform";

export type Outputs = { [key: string]: TerraformOutput };
export type OutputIdMapLeaf = { [constructId: string]: string };
export type OutputIdMapNode = { [stackOrConstructId: string]: OutputIdMap };
export type OutputIdMap = OutputIdMapLeaf | OutputIdMapNode;

function unpackTerraformOutput(
  outputs: NestedTerraformOutputs,
  includeSensitiveOutputs: boolean,
): Record<string, string> {
  return Object.entries(outputs).reduce((acc, [key, entry]) => {
    if (isTerraformOutput(entry)) {
      return {
        ...acc,
        [key]:
          !entry.sensitive || includeSensitiveOutputs ? entry.value : undefined,
      };
    }
    // Defensive hardening: `entry` comes from externally-sourced data (terraform output metadata
    // mapped by getConstructIdsForOutputs), and Object.entries() below would throw on a null or
    // undefined entry. Omit the key rather than recurse into it or retain an undefined/null value -
    // consistent with how getConstructIdsForOutputs omits unresolved outputs.
    if (entry === null || typeof entry !== "object") {
      return acc;
    }
    return {
      ...acc,
      [key]: unpackTerraformOutput(entry, includeSensitiveOutputs),
    };
  }, {});
}

export async function saveOutputs(
  filePath: string,
  outputs: NestedTerraformOutputs,
  includeSensitiveOutputs: boolean,
) {
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      unpackTerraformOutput(outputs, includeSensitiveOutputs),
      null,
      2,
    ),
  );
}

export function normalizeOutputPath(filePath: string) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
}

export type NestedTerraformOutputs =
  | { [key: string]: TerraformOutput }
  | { [key: string]: NestedTerraformOutputs };

const mapActionToState = (action: ActionTypes, done: boolean) => {
  switch (action) {
    case "create":
    case "update":
      return done
        ? DeployingResourceApplyState.CREATED
        : DeployingResourceApplyState.CREATING;
    case "delete":
      return done
        ? DeployingResourceApplyState.DESTROYED
        : DeployingResourceApplyState.DESTROYING;
    default:
      return DeployingResourceApplyState.WAITING;
  }
};
// This is deprecated and will be removed in a future version.
const parseJsonOutputLine = (
  line: string,
): Omit<DeployingResource, "action"> | undefined => {
  let json, message;
  try {
    json = JSON.parse(line);
  } catch {
    logger.trace(`Could not parse line as JSON: ${line}`);
    return;
  }

  try {
    message = schema.parse(json);
  } catch (err) {
    if (err instanceof z.ZodError) {
      logger.trace(
        `Error parsing line into schema: ${JSON.stringify(
          err.issues,
        )} => ${line}`,
      );
    }

    return;
  }

  switch (message.type) {
    case "apply_start":
    case "apply_progress":
      return {
        id: message.hook.resource.resource,
        applyState: mapActionToState(message.hook.action, false),
      };

    case "apply_complete":
      return {
        id: message.hook.resource.resource,
        applyState: mapActionToState(message.hook.action, true),
      };
    default:
      return;
  }
};

const parseTextOutputLine = (
  line: string,
): Omit<DeployingResource, "action"> | undefined => {
  if (/^Outputs:/.test(line)) {
    return;
  }
  if (/^Plan:/.test(line)) {
    return;
  }
  if (/^data\..*/.test(line)) {
    return;
  }

  const resourceMatch = line.match(/^([a-zA-Z_][a-zA-Z\d_\-.]*):/);
  let applyState: DeployingResourceApplyState;

  switch (true) {
    case /Creating.../.test(line):
    case /Still creating.../.test(line):
      applyState = DeployingResourceApplyState.CREATING;
      break;
    case /Creation complete/.test(line):
      applyState = DeployingResourceApplyState.CREATED;
      break;
    case /Modifying.../.test(line):
      applyState = DeployingResourceApplyState.UPDATING;
      break;
    case /Modifications complete/.test(line):
      applyState = DeployingResourceApplyState.UPDATED;
      break;
    case /Destroying.../.test(line):
    case /Still destroying.../.test(line):
      applyState = DeployingResourceApplyState.DESTROYING;
      break;
    case /Destruction complete/.test(line):
      applyState = DeployingResourceApplyState.DESTROYED;
      break;
    default:
      return;
  }

  if (
    resourceMatch &&
    resourceMatch.length >= 0 &&
    resourceMatch[1] != "Warning"
  ) {
    return {
      id: resourceMatch[1],
      applyState,
    };
  } else {
    return;
  }
};

export const parseOutput = (str: string): DeployingResource[] => {
  const lines = stripAnsi(str.toString()).split("\n");

  const resources = lines.map((line) => {
    const parsed = parseJsonOutputLine(line) || parseTextOutputLine(line);
    if (parsed === undefined) {
      return;
    }

    const { id, applyState } = parsed;
    return {
      id,
      applyState,
      action: PlannedResourceAction.CREATE,
    };
  });

  return resources.reduce((acc, resource) => {
    if (resource) {
      acc.push(resource);
    }
    return acc;
    // eslint-disable-next-line @typescript-eslint/no-array-constructor
  }, new Array());
};

// Matches the prefix TerraformStack.registerOutgoingCrossStackReference() uses when it
// synthesizes an output for a cross-stack dependency (packages/cdktn/src/terraform-stack.ts).
// There is no shared constant to import for it - the identifier is not exported anywhere - so the
// prefix is duplicated here.
const CROSS_STACK_OUTPUT_PREFIX = "cross-stack-output-";

const isObjectEmpty = (obj: Record<string, any>): boolean => {
  if (typeof obj !== "object") {
    return false;
  }
  return (
    Object.keys(obj).length === 0 ||
    Object.values(obj).every(
      (v) => v === undefined || v === null || isObjectEmpty(v),
    )
  );
};

export const getConstructIdsForOutputs = (
  stackContent: Record<string, any>,
  outputs: { [key: string]: TerraformOutput },
): NestedTerraformOutputs => {
  // Older cdktf versions might not have the output metadata
  if (!("//" in stackContent) || !("outputs" in stackContent["//"])) {
    return outputs;
  }
  const outputsMapping = stackContent["//"].outputs;

  const mapOutputs = (value: OutputIdMap): NestedTerraformOutputs => {
    return Object.entries(value).reduce((acc, [key, value]) => {
      if (typeof value === "string") {
        const resolved = outputs[value];
        if (resolved === undefined) {
          // The metadata declares an output that terraform did not return (state drift,
          // --skip-synth, a renamed/removed output, ...). Omit the key entirely rather than
          // retaining it with an undefined value, which would later crash the renderer.
          //
          // Cross-stack outputs are generated plumbing for stack dependencies rather than
          // something the user declared directly, and a dependent stack legitimately produces
          // many of them - warning on each missing one would be noise the user cannot act on.
          // A directly user-declared output silently going missing is exactly the kind of
          // condition that made the original crash hard to diagnose, so it gets a warning.
          const message = `Output "${value}" (construct id "${key}") declared in stack metadata but absent from terraform output; omitting it.`;
          if (value.startsWith(CROSS_STACK_OUTPUT_PREFIX)) {
            logger.debug(message);
          } else {
            logger.warn(message);
          }
          return acc;
        }
        return { ...acc, [key]: resolved };
      }

      const mapped = mapOutputs(value);
      if (isObjectEmpty(mapped)) {
        return acc;
      }

      return {
        ...acc,
        [key]: mapped,
      };
    }, {});
  };

  return mapOutputs(outputsMapping);
};
