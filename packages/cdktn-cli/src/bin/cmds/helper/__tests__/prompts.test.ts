// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  PROMPT_NEEDS_TTY,
  isNonTtyError,
  promptApprove,
  promptOverride,
} from "../prompts";

describe("isNonTtyError", () => {
  it("matches an Error whose message is PROMPT_NEEDS_TTY", () => {
    expect(isNonTtyError(new Error(PROMPT_NEEDS_TTY))).toBe(true);
  });

  it("rejects other errors and non-error values", () => {
    expect(isNonTtyError(new Error("anything else"))).toBe(false);
    expect(isNonTtyError("string")).toBe(false);
    expect(isNonTtyError(undefined)).toBe(false);
    expect(isNonTtyError({ message: PROMPT_NEEDS_TTY })).toBe(false);
  });
});

describe("prompt TTY guard", () => {
  // Save and restore so we don't leak state into other tests.
  const originalIsTTY = process.stdin.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it("promptApprove throws PROMPT_NEEDS_TTY when stdin is not a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    await expect(promptApprove("any-stack")).rejects.toThrow(PROMPT_NEEDS_TTY);
  });

  it("promptOverride throws PROMPT_NEEDS_TTY when stdin is not a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    await expect(promptOverride("any-stack")).rejects.toThrow(PROMPT_NEEDS_TTY);
  });
});
