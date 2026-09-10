// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as Sentry from "@sentry/node";
// telemetry.ts must never import this module: it would close a cycle through
// terraform.ts and load errors.ts before the factories exist.
import { CommandErrorType, sendErrorTelemetry } from "./telemetry";
import { processState } from "./process-state";

type ErrorType = "Internal" | "External" | "Usage";
export function IsErrorType(error: any, type: ErrorType): boolean {
  return error && error.__type === type;
}

/** Metric class of a thrown value: its `Errors` type, "unexpected" otherwise. */
export function commandErrorType(error: unknown): CommandErrorType {
  for (const type of ["Usage", "External", "Internal"] as const) {
    if (IsErrorType(error, type)) {
      return type;
    }
  }
  return "unexpected";
}

function reportPrefixedError(type: ErrorType) {
  return (
    message: string,
    originalError: Error = new Error(),
    context?: Record<string, any>,
  ) => {
    const err: any = new Error(`${type} Error: ${message}`);
    Object.entries(context || {}).forEach(([key, value]) => {
      err[key] = value;
    });
    err.__type = type;
    err.stack = originalError.stack;
    // the scope is read here, not when the factory is created, so the
    // command set by setScope is the one counted
    sendErrorTelemetry(type, scopeState.scope);
    return err;
  };
}

// The CLI only deals with one command at a time, so we can just use the same
// scope for all errors and set it once during initialization (bin/cdktn.js
// sets it, the bundle copy in bin/cmds/handlers.js counts under it).
const scopeState = processState("cdktn.errorScope", () => ({
  scope: "unknown",
}));
export const Errors = {
  // Error within our control
  Internal: reportPrefixedError("Internal"),
  // Error in the usage
  Usage: reportPrefixedError("Usage"),
  // Error outside of our control (e.g. terraform failed)
  External: reportPrefixedError("External"),

  // Set the scope for all errors
  setScope(scope: string) {
    scopeState.scope = scope;
    Sentry.getCurrentScope().setTransactionName(scope);
  },

  getScope(): string {
    return scopeState.scope;
  },
};
