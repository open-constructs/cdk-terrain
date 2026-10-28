// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

import { Errors } from "@cdktn/commons";

// The subset of yargs' internal options object that is needed to tell which
// options a command knows about. It is returned by `getOptions()`.
export type KnownOptions = {
  key?: Record<string, unknown>;
  alias?: Record<string, string[]>;
  envPrefix?: string;
};

// Options that are accepted by every command without being declared:
// - chalk (via supports-color) reads --color and --no-color straight from process.argv, so they
//   take effect on every command
// - yargs adds --get-yargs-completions to the arguments of a shell completion request, and the
//   completion of stack names runs the command's parser
const ALWAYS_ACCEPTED_FLAGS = ["color", "no-color", "get-yargs-completions"];

const camelCase = (str: string): string =>
  str.replace(/[-_]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * Returns the options in `argv` that the current command does not declare.
 *
 * yargs' own `.strictOptions()` is not usable here: the CLI reads options from
 * `CDKTF_*` environment variables (`.env("CDKTF")`), and yargs would report
 * every unrelated variable with that prefix (e.g. CDKTF_DISABLE_LOGGING) as an
 * unknown option and fail every command. Options that only came from the
 * environment are therefore ignored.
 */
export function findUnknownOptions(
  argv: Record<string, unknown>,
  options: KnownOptions,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const known = new Set<string>(["_", "$0", "--"]);
  for (const flag of ALWAYS_ACCEPTED_FLAGS) {
    known.add(flag);
    known.add(camelCase(flag));
  }
  for (const key of Object.keys(options.key ?? {})) {
    known.add(key);
    known.add(camelCase(key));
  }
  for (const aliases of Object.values(options.alias ?? {})) {
    for (const alias of aliases) {
      known.add(alias);
      known.add(camelCase(alias));
    }
  }

  const fromEnv = new Set<string>();
  if (options.envPrefix) {
    const prefix = `${options.envPrefix}_`;
    for (const name of Object.keys(env)) {
      if (name.startsWith(prefix)) {
        fromEnv.add(camelCase(name.slice(prefix.length).toLowerCase()));
      }
    }
  }

  // yargs adds both the kebab-case and the camelCase spelling of every
  // option to argv, report each unknown option only once
  const unknown = new Map<string, string>();
  for (const key of Object.keys(argv)) {
    const normalized = camelCase(key);
    if (
      !known.has(key) &&
      !known.has(normalized) &&
      !fromEnv.has(key) &&
      !unknown.has(normalized)
    ) {
      unknown.set(normalized, key);
    }
  }
  return [...unknown.values()];
}

// How yargs describes the command it matched. These are yargs internals, there is no public API
// for them, so every access is guarded.
type YargsLike = {
  getOptions(): KnownOptions;
  showHelp(): unknown;
  getInternalMethods?: () => {
    getContext?: () => { commands?: string[] };
    getCommandInstance?: () => { getCommands?: () => string[] };
  };
};

/**
 * Whether the arguments name a command (or a subcommand of a command group like `provider`) that
 * does not exist, for example `cdktn deploi` or `cdktn provider bogus`. The options of such a
 * command line can not be checked: they would be validated against the options of the parent, so
 * a perfectly valid flag would be blamed for what is really a mistyped command. The user gets the
 * message about the command instead.
 */
function hasUnmatchedCommand(
  argv: Record<string, unknown>,
  y: YargsLike,
): boolean {
  const internals = y.getInternalMethods?.();
  if (!internals) {
    // can not tell, so check the options rather than let a typo through
    return false;
  }
  const matched = internals.getContext?.().commands ?? [];
  const subcommands = internals.getCommandInstance?.().getCommands?.() ?? [];
  const positionals = (argv._ as unknown[] | undefined) ?? [];
  if (matched.length === 0) {
    // nothing matched at the top level, the arguments hold the mistyped command
    return positionals.length > 0;
  }
  // a command group matched, but what follows it is not one of its subcommands
  return subcommands.length > 0 && positionals.length > matched.length;
}

const HINT =
  "cdktn does not forward flags to terraform or tofu. Set them with the TF_CLI_ARGS_<command> environment variable instead.";

/**
 * A single dash followed by a long name, like `-target=x` or `-var-file=f`, is parsed by yargs as a
 * group of short options (`t`, `r`, `g`, ...). Report the token as it was written instead, with the
 * double dash spelling it most likely meant.
 */
function describeUnknown(unknown: string[], rawArgs: string[]): string[] {
  const described: string[] = [];
  const explained = new Set<string>();
  for (const token of rawArgs) {
    if (token === "--") {
      break;
    }
    if (/^-[a-zA-Z][a-zA-Z0-9_-]+(=.*)?$/.test(token)) {
      const [flag] = token.split("=");
      for (const letter of flag.slice(1)) {
        explained.add(letter);
      }
      if (unknown.some((key) => key.length === 1 && flag.includes(key))) {
        described.push(`${token} (did you mean -${token}?)`);
      }
    }
  }
  return [
    ...described,
    ...unknown.filter((key) => !(key.length === 1 && explained.has(key))),
  ];
}

// Fails the command on unknown options. This is a middleware and not a yargs
// `.check()`: a failing check is reported through `.fail()` but yargs still goes
// on to run the command handler, so a mistyped flag would be ignored anyway.
// Because throwing bypasses `.showHelpOnFail()`, the usage of the command is
// printed here, the same way yargs' strict mode does it.
export function rejectUnknownOptions(
  argv: Record<string, unknown>,
  y: YargsLike,
  rawArgs: string[] = process.argv.slice(2),
): void {
  if (hasUnmatchedCommand(argv, y)) {
    return;
  }
  const unknown = findUnknownOptions(argv, y.getOptions());
  if (unknown.length > 0) {
    // the command handler never runs, so it can not set the scope itself
    Errors.setScope(String((argv._ as unknown[] | undefined)?.[0] ?? "cdktn"));
    y.showHelp();
    const described = describeUnknown(unknown, rawArgs);
    throw Errors.Usage(
      `Unknown argument${described.length > 1 ? "s" : ""}: ${described.join(", ")}\n${HINT}`,
    );
  }
}
