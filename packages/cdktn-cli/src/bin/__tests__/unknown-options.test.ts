// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import yargs from "yargs";
import { Errors } from "@cdktn/commons";
import { findUnknownOptions, rejectUnknownOptions } from "../unknown-options";

const options = {
  key: { app: true, "auto-approve": true, var: true, v: true, stacks: true },
  alias: { var: ["v"] },
  envPrefix: "CDKTF",
};

describe("findUnknownOptions", () => {
  it("accepts declared options in kebab and camel case, aliases and positionals", () => {
    const argv = {
      _: ["deploy"],
      $0: "cdktn",
      app: "x",
      "auto-approve": true,
      autoApprove: true,
      var: ["a=b"],
      v: ["a=b"],
      stacks: ["s"],
    };
    expect(findUnknownOptions(argv, options, {})).toEqual([]);
  });

  it("reports an unknown option once, even though yargs adds two spellings", () => {
    const argv = { _: [], "skip-synth-typo": true, skipSynthTypo: true };
    expect(findUnknownOptions(argv, options, {})).toEqual(["skip-synth-typo"]);
  });

  it("ignores options that only came from CDKTF_ environment variables", () => {
    const argv = { _: [], disableLogging: true, home: "/x", zzz: true };
    const env = { CDKTF_DISABLE_LOGGING: "true", CDKTF_HOME: "/x" };
    expect(findUnknownOptions(argv, options, env)).toEqual(["zzz"]);
  });
});

describe("findUnknownOptions and the chalk color flags", () => {
  it("always accepts --color, --no-color and the shell completion flag", () => {
    const argv = {
      _: [],
      color: true,
      "no-color": true,
      noColor: true,
      "get-yargs-completions": true,
      getYargsCompletions: true,
    };
    expect(findUnknownOptions(argv, options, {})).toEqual([]);
  });
});

describe("rejectUnknownOptions", () => {
  afterEach(() => jest.restoreAllMocks());

  const argv = { _: ["deploy"], "auto-aprove": true, autoAprove: true };

  it("prints the usage and sets the error scope before failing", () => {
    const showHelp = jest.fn();
    const setScope = jest.spyOn(Errors, "setScope");

    expect(() =>
      rejectUnknownOptions(argv, { getOptions: () => options, showHelp }),
    ).toThrow("Unknown argument: auto-aprove");
    expect(showHelp).toHaveBeenCalledTimes(1);
    expect(setScope).toHaveBeenCalledWith("deploy");
  });

  it("does nothing for known options", () => {
    const showHelp = jest.fn();
    expect(() =>
      rejectUnknownOptions(
        { _: ["deploy"], app: "x" },
        { getOptions: () => options, showHelp },
      ),
    ).not.toThrow();
    expect(showHelp).not.toHaveBeenCalled();
  });
});

describe("rejectUnknownOptions for a mistyped command", () => {
  const yargsFor = (matched: string[], subcommands: string[]) => ({
    getOptions: () => options,
    showHelp: jest.fn(),
    getInternalMethods: () => ({
      getContext: () => ({ commands: matched }),
      getCommandInstance: () => ({ getCommands: () => subcommands }),
    }),
  });

  it("does not check the options when nothing matched at the top level", () => {
    const y = yargsFor([], []);
    expect(() =>
      rejectUnknownOptions({ _: ["deploi"], bogus: true }, y, []),
    ).not.toThrow();
    expect(y.showHelp).not.toHaveBeenCalled();
  });

  it("does not check the options when a subcommand of a group does not exist", () => {
    const y = yargsFor(["provider"], ["add", "list"]);
    expect(() =>
      rejectUnknownOptions({ _: ["provider", "bogus"], bogus: true }, y, []),
    ).not.toThrow();
  });

  it("still checks the options of a group without a stray subcommand", () => {
    const y = yargsFor(["provider"], ["add", "list"]);
    expect(() =>
      rejectUnknownOptions({ _: ["provider"], bogus: true }, y, []),
    ).toThrow("Unknown argument: bogus");
  });

  it("still checks the options when an extra positional follows a plain command", () => {
    const y = yargsFor(["diff"], []);
    expect(() =>
      rejectUnknownOptions({ _: ["diff", "extra"], bogus: true }, y, []),
    ).toThrow("Unknown argument: bogus");
  });
});

describe("rejectUnknownOptions messages", () => {
  const y = { getOptions: () => options, showHelp: jest.fn() };

  it("points to TF_CLI_ARGS_<command>", () => {
    expect(() =>
      rejectUnknownOptions({ _: ["synth"], bogus: true }, y, []),
    ).toThrow("TF_CLI_ARGS_<command>");
  });

  it("reports a single dash long flag as written", () => {
    const argv = { _: ["synth"], t: true, r: true, g: true, e: true };
    expect(() =>
      rejectUnknownOptions(argv, y, ["synth", "-target=aws_s3_bucket.a"]),
    ).toThrow(
      "Unknown argument: -target=aws_s3_bucket.a (did you mean --target=aws_s3_bucket.a?)",
    );
  });

  it("keeps other unknown options next to the single dash flag", () => {
    const argv = { _: ["synth"], t: true, r: true, bogus: true };
    expect(() => rejectUnknownOptions(argv, y, ["-tr", "--bogus"])).toThrow(
      /Unknown arguments: -tr \(did you mean --tr\?\), bogus/,
    );
  });
});

describe("cli with the middleware applied", () => {
  const handler = jest.fn();
  const run = (args: string[]) =>
    yargs(args)
      .env("CDKTF")
      .exitProcess(false)
      .showHelpOnFail(false)
      .command({
        command: "deploy [stacks..]",
        builder: (y) =>
          y
            .positional("stacks", { type: "string", array: true })
            .option("auto-approve", { type: "boolean" }),
        handler,
      })
      .middleware(rejectUnknownOptions as unknown as yargs.MiddlewareFunction)
      .parseAsync();

  beforeEach(() => handler.mockClear());

  it("runs the command for known options", async () => {
    await run(["deploy", "a", "--auto-approve"]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown option without running the command", async () => {
    await expect(async () =>
      run(["deploy", "a", "--auto-aprove"]),
    ).rejects.toThrow("Unknown argument: auto-aprove");
    expect(handler).not.toHaveBeenCalled();
  });
});
