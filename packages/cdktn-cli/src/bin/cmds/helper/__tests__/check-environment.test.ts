// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { isInteractiveTerminal } from "../check-environment";

describe("isInteractiveTerminal", () => {
  const original = {
    stdin: process.stdin.isTTY,
    stdout: process.stdout.isTTY,
    ci: process.env.CI,
  };

  const setTerminal = (stdin: boolean, stdout: boolean, ci?: string) => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: stdin,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: stdout,
      configurable: true,
    });
    if (ci === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = ci;
    }
  };

  afterEach(() => {
    setTerminal(original.stdin, original.stdout, original.ci);
  });

  it.each<[string, boolean, boolean, string | undefined, boolean]>([
    ["both terminals outside CI", true, true, undefined, true],
    ["stdout terminal with piped stdin", false, true, undefined, false],
    ["stdin terminal with piped stdout", true, false, undefined, false],
    ["both terminals in CI", true, true, "true", false],
  ])("%s -> %p", (_case, stdin, stdout, ci, expected) => {
    setTerminal(stdin, stdout, ci);
    expect(isInteractiveTerminal()).toBe(expected);
  });
});
