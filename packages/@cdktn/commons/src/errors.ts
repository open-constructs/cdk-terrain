// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as Sentry from "@sentry/node";
import { sendErrorTelemetry } from "./telemetry";

type ErrorType = "Internal" | "External" | "Usage";
export function IsErrorType(error: any, type: ErrorType): boolean {
  return error && error.__type === type;
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
    // errorScope is read here, not when the factory is created, so the
    // command set by setScope is the one counted
    sendErrorTelemetry(type, errorScope);
    return err;
  };
}

// The CLI only deals with one command at a time, so we can just use the same
// scope for all errors and set it once during initialization.
let errorScope = "unknown";
export const Errors = {
  // Error within our control
  Internal: reportPrefixedError("Internal"),
  // Error in the usage
  Usage: reportPrefixedError("Usage"),
  // Error outside of our control (e.g. terraform failed)
  External: reportPrefixedError("External"),

  // Set the scope for all errors
  setScope(scope: string) {
    errorScope = scope;
    Sentry.getCurrentScope().setTransactionName(scope);
  },
};
