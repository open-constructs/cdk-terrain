/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import tty from "tty";

// chalk reads FORCE_COLOR, argv and the TTY state once, when it is loaded, so
// each case loads a fresh copy of the module with the environment it needs.
function noColorDefault(
  env: Record<string, string | undefined>,
  { stdoutIsTTY = false, argv = [] as string[] } = {},
): boolean {
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  const isatty = jest.spyOn(tty, "isatty").mockReturnValue(stdoutIsTTY);
  try {
    delete process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    delete process.env.TERM;
    delete process.env.CI;
    Object.assign(process.env, env);
    process.argv = [...savedArgv, ...argv];
    let result: boolean | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      result = require("../color").noColorDefault();
    });
    return result as boolean;
  } finally {
    isatty.mockRestore();
    process.argv = savedArgv;
    process.env = savedEnv;
  }
}

describe("noColorDefault", () => {
  it("turns color off when stdout is piped or redirected", () => {
    expect(noColorDefault({})).toBe(true);
  });

  it("keeps color on in a terminal", () => {
    expect(
      noColorDefault({ TERM: "xterm-256color" }, { stdoutIsTTY: true }),
    ).toBe(false);
  });

  it.each(["0", "false"])("turns color off for FORCE_COLOR=%s", (value) => {
    expect(noColorDefault({ FORCE_COLOR: value })).toBe(true);
    expect(noColorDefault({ FORCE_COLOR: value }, { stdoutIsTTY: true })).toBe(
      true,
    );
  });

  it.each(["1", "true", ""])(
    "keeps color on for piped output with FORCE_COLOR=%j",
    (value) => {
      expect(noColorDefault({ FORCE_COLOR: value })).toBe(false);
    },
  );

  it("keeps color on for piped output with --color", () => {
    expect(noColorDefault({}, { argv: ["--color"] })).toBe(false);
  });

  it("turns color off in a terminal with --no-color", () => {
    expect(
      noColorDefault(
        { TERM: "xterm-256color" },
        { stdoutIsTTY: true, argv: ["--no-color"] },
      ),
    ).toBe(true);
  });
});
