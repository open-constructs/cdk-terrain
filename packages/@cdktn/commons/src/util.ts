// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { SpawnOptions } from "child_process";
import { spawn } from "cross-spawn";
import * as fs from "fs-extra";
import { https, http } from "follow-redirects";
import * as os from "os";
import * as path from "path";
import { processLoggerError, processLoggerDebug } from "./logging";
import { IManifest, Manifest } from "cdktn";
import * as config from "./config";
import stripAnsi from "strip-ansi";

type ExecError = Error & { stderr: string; stdout: string };

/**
 * Attach captured stderr/stdout to a process-failure Error.
 *
 * The body text is exposed two ways:
 * - `.stderr` and `.stdout` properties, for callers that render the streams separately (e.g. synth-stack's chalk
 *   formatting).
 * - A `toString()` override that appends the body after the headline, so callers using `${e}` interpolation surface the
 *   underlying tool output without double-printing for the property-reading callers.
 *
 * The Error's `.message` is left untouched as the headline only.
 *
 * @param error the Error to decorate (its `.message` becomes the toString headline)
 * @param stderrText captured stderr, may be empty
 * @param stdoutText captured stdout, may be empty
 */
function attachProcessOutput(
  error: Error,
  stderrText: string,
  stdoutText: string,
): asserts error is ExecError {
  (error as ExecError).stderr = stderrText;
  (error as ExecError).stdout = stdoutText;
  const body = [stderrText, stdoutText].filter(Boolean).join("\n");
  if (body) {
    const headline = error.message;
    error.toString = () => `Error: ${headline}\n${body}`;
  }
}

/**
 * Spawn a child process and mirror its stdout to the parent's console.
 *
 * Thin wrapper over {@link exec} for callers that want stdout chunks echoed via `console.log` as they arrive. Stderr is
 * captured silently and surfaced on the thrown Error's `.stderr` / `toString()` if the process exits non-zero.
 *
 * @param program the executable to spawn
 * @param args arguments passed to the executable
 * @param options spawn options; `noColor: true` strips ANSI escapes from captured output
 * @returns the full concatenated stdout as a string on success
 * @throws an Error with `.stderr` and `.stdout` properties (see {@link attachProcessOutput}) on non-zero exit
 */
export async function shell(
  program: string,
  args: string[] = [],
  options: SpawnOptions & { noColor?: boolean } = {},
) {
  return exec(
    program,
    args,
    options,
    (chunk: string) => {
      const sanitizedChunk = options.noColor
        ? stripAnsi(chunk.toLocaleString())
        : chunk.toLocaleString();
      console.log(sanitizedChunk);
    },
    () => {
      // No-op: passing a callback (vs. undefined) suppresses exec()'s default
      // pass-through to process.stderr; inner exec() still collects it for
      // the thrown error's .stderr field.
    },
  );
}

export async function withTempDir(
  dirname: string,
  closure: () => Promise<void>,
) {
  const prevdir = process.cwd();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cdktf."));
  const workdir = path.join(parent, dirname);
  await fs.mkdirp(workdir);
  try {
    process.chdir(workdir);
    await closure();
  } finally {
    process.chdir(prevdir);
    await fs.remove(parent);
  }
}

export async function mkdtemp(closure: (dir: string) => Promise<void>) {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "cdktf."));
  try {
    await closure(workdir);
  } finally {
    await fs.remove(workdir);
  }
}

/**
 * Spawn a child process and resolve with its stdout, or reject with a decorated Error on non-zero exit.
 *
 * Captured stdout and stderr are always tee'd to `processLoggerDebug` / `processLoggerError`. The optional `stdout` and
 * `stderr` callbacks receive each sanitized chunk as it arrives — useful for streaming output to the terminal.
 * Passing a `stderr` callback (even a no-op) suppresses the default pass-through to `process.stderr` for that stream.
 *
 * On non-zero exit, rejects with an {@link ExecError} carrying `.stderr` / `.stdout` and a `toString()` that includes
 * the captured body (see {@link attachProcessOutput}); `.message` itself stays as the headline.
 *
 * @param command the executable to spawn
 * @param args arguments passed to the executable
 * @param options spawn options; `noColor: true` strips ANSI escapes from captured output (auto-detected from CLI flags
 *  / `FORCE_COLOR=0` when omitted); `logStderrAsDebug: true` tees stderr to `processLoggerDebug` instead, for runs
 *  whose diagnostics are not final and would only alarm the reader
 * @param stdout optional per-chunk callback for sanitized stdout
 * @param stderr optional per-chunk callback for sanitized stderr; passing a callback suppresses default terminal echo
 * @param sendToStderr when false, suppresses both the stderr callback invocation and the default terminal echo
 * @returns the full concatenated stdout as a string on success
 */
export const exec = async (
  command: string,
  args: string[],
  options: SpawnOptions & { noColor?: boolean; logStderrAsDebug?: boolean },
  stdout?: (chunk: string) => any,
  stderr?: (chunk: string | Uint8Array) => any,
  sendToStderr = true,
): Promise<string> => {
  // if options.noColor is not set, checking the flags & environment if it should be set
  // This is required for collectDebugInformation() which does not have knowledge about flags
  if (typeof options.noColor !== "boolean" && hasNoColorFlagOrEnv()) {
    options.noColor = true;
  }

  // Drop spawn's `signal` option: the child already gets the interrupt via the process group, and a second signal
  // aborts terraform's graceful shutdown. Just wait for its own "close".
  const { signal: _signal, logStderrAsDebug, ...spawnOptions } = options;

  const logStderr = logStderrAsDebug ? processLoggerDebug : processLoggerError;

  return new Promise((ok, ko) => {
    const child = spawn(command, args, spawnOptions);
    const out = new Array<string>();
    const err = new Array<string>();
    if (stdout !== undefined) {
      child.stdout?.on("data", (chunk: Buffer) => {
        const sanitizedChunk = options.noColor
          ? stripAnsi(chunk.toLocaleString())
          : chunk.toLocaleString();
        processLoggerDebug(sanitizedChunk);
        out.push(sanitizedChunk);
        stdout(sanitizedChunk);
      });
    } else {
      child.stdout?.on("data", (chunk: Buffer) => {
        const sanitizedChunk = options.noColor
          ? stripAnsi(chunk.toLocaleString())
          : chunk.toLocaleString();
        processLoggerDebug(sanitizedChunk);
        out.push(sanitizedChunk);
      });
    }
    if (stderr !== undefined) {
      child.stderr?.on("data", (chunk: string | Uint8Array) => {
        const sanitizedChunk = options.noColor
          ? stripAnsi(chunk.toLocaleString())
          : chunk.toLocaleString();
        logStderr(sanitizedChunk);
        if (sendToStderr) {
          stderr(sanitizedChunk);
        }
        err.push(sanitizedChunk);
      });
    } else {
      child.stderr?.on("data", (chunk: string | Uint8Array) => {
        const sanitizedChunk = options.noColor
          ? stripAnsi(chunk.toLocaleString())
          : chunk.toLocaleString();
        logStderr(sanitizedChunk);
        if (sendToStderr) {
          process.stderr.write(sanitizedChunk);
        }
        err.push(sanitizedChunk);
      });
    }
    child.once("error", (err: any) => ko(err));
    child.once("close", (code: number) => {
      if (code !== 0) {
        const error = new Error(
          `${command} ${args.join(" ")} exited with code ${code}`,
        );
        attachProcessOutput(error, err.join(""), out.join(""));
        return ko(error);
      }
      return ok(out.join(""));
    });
  });
};

export async function readCDKTFVersion(outputDir: string): Promise<string> {
  const outputFile = path.join(outputDir, "cdk.tf.json");
  if (fs.existsSync(outputFile)) {
    const outputJSON = fs.readFileSync(outputFile, "utf8");
    const data = JSON.parse(outputJSON);
    return data["//"].metadata.version;
  }

  return "";
}

export async function readCDKTFManifest(): Promise<IManifest> {
  const { output } = config.readConfigSync();
  const json = await fs.readFile(path.join(output, Manifest.fileName));
  return JSON.parse(json.toString()) as IManifest;
}

/**
 * Downcase the first character in a string.
 *
 * @param str the string to be processed.
 */
export function downcaseFirst(str: string): string {
  if (str === "") {
    return str;
  }
  return `${str[0].toLocaleLowerCase()}${str.slice(1)}`;
}

export class HttpError extends Error {
  constructor(
    message?: string,
    public statusCode?: number,
  ) {
    super(message); // 'Error' breaks prototype chain here
    Object.setPrototypeOf(this, new.target.prototype); // restore prototype chain
    // see: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-2.html#support-for-newtarget
  }
}

export async function downloadFile(
  url: string,
  targetFilename: string,
): Promise<void> {
  // if the type is inferred to be "http|https" calling .get() is not possible
  // because the options parameter (which we don't use anyway) for get is
  // not compatible between http and https -> so we treat it as http
  const client = (url.startsWith("http://") ? http : https) as typeof http;
  const file = fs.createWriteStream(targetFilename);
  return new Promise((ok, ko) => {
    const request = client.get(url, (response) => {
      if (response.statusCode !== 200) {
        ko(
          new HttpError(
            `Failed to get '${url}' (${response.statusCode})`,
            response.statusCode,
          ),
        );
        return;
      }
      response.pipe(file);
    });

    file.on("finish", () => ok());

    request.on("error", (err: Error) => {
      fs.unlink(targetFilename, () => ko(err));
    });

    file.on("error", (err) => {
      fs.unlink(targetFilename, () => ko(err));
    });

    request.end();
  });
}

/**
 * Awaits a promise and makes sure it's error (if any) is only thrown after all other promises are settled
 * if the promise does not throw an error, the other promises won't be awaited
 * @param p promise to await
 * @param promises promises to await to be all settled if p failed before throwing error that p failed with
 */
export async function ensureAllSettledBeforeThrowing(
  p: Promise<any>,
  promises: (Promise<any> | undefined)[],
) {
  try {
    await p;
  } catch (e) {
    // if an error happened, we still need to wait for all other promises that
    // are currently in progress to complete to allow them to properly wrap up
    await Promise.allSettled(promises);
    throw e;
  }
}

/**
 * returns true if --no-color is passed as CLI flag or the env var FORCE_COLOR is set to "0"
 * Used for cases where we can't pass down the noColor flag (e.g. when collecting debug information from the environment)
 * This is the same behavior as the `chalk` lib we use for coloring output
 */
export function hasNoColorFlagOrEnv(): boolean {
  return hasFlag("no-color") || process.env.FORCE_COLOR === "0";
}

// From: https://github.com/sindresorhus/has-flag/blob/main/index.js
// as used in https://github.com/chalk/chalk
function hasFlag(flag: string) {
  const prefix = flag.startsWith("-") ? "" : flag.length === 1 ? "-" : "--";
  const position = process.argv.indexOf(prefix + flag);
  const terminatorPosition = process.argv.indexOf("--");
  return (
    position !== -1 &&
    (terminatorPosition === -1 || position < terminatorPosition)
  );
}
