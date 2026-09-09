// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
const flush = jest.fn().mockResolvedValue(undefined);
jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  flushTelemetry: (...args: unknown[]) => flush(...args),
}));

import { createBeforeExitFlush } from "../exit-flush";

describe("createBeforeExitFlush", () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    flush.mockClear();
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  // awaiting the flush drains the loop, so beforeExit fires again: without
  // the guard the success path would flush (and exit) twice
  it("flushes and exits once, however often beforeExit fires", async () => {
    const exit = jest.fn();
    const onBeforeExit = createBeforeExitFlush(exit);

    await onBeforeExit();
    await onBeforeExit();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("keeps the exit code the run already set", async () => {
    const exit = jest.fn();
    process.exitCode = 3;

    await createBeforeExitFlush(exit)();

    expect(exit).toHaveBeenCalledWith(3);
  });
});
