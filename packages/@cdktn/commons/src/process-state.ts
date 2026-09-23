// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

// The CLI bundle carries one copy of commons per esbuild entry point
// (bin/cdktn.js and bin/cmds/handlers.js); state a command sets in one copy
// and reads in the other has to live on globalThis, keyed by a shared symbol.
export function processState<T extends object>(key: string, init: () => T): T {
  const globals = globalThis as { [key: symbol]: T | undefined };
  return (globals[Symbol.for(key)] ??= init());
}
