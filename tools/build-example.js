/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

// Builds a single example, passed  as the first argument.

const path = require("path");
const util = require("util");
const exec = util.promisify(require("child_process").exec);

async function run(command) {
  console.log(`Running: ${command}`);
  const { stdout, stderr } = await exec(command, {
    env: {
      ...process.env,
      CI: "true", // Disable spinner even when we have a TTY
    },
    maxBuffer: 256 * 1024 * 1024, // ~270 MB; Nodejs default is 1024 * 1024 (bytes) which is ~1 MiB
    cwd: path.resolve(__dirname, ".."),
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}

const exampleToBuild = process.argv[2];

if (!exampleToBuild) {
  console.error("No example to build specified");
  process.exit(1);
}

async function runInExample(command) {
  try {
    return await run(
      `pnpm exec lerna run --scope='${exampleToBuild}' ${command}`,
    );
  } catch (e) {
    const err = new Error(
      `Failed to run ${command} in ${exampleToBuild} with status ${e.code} and signal ${e.signal}`,
    );
    console.error(e.message);
    console.error(e);
    console.error("STDERR:");
    process.stderr.write(e.stderr);
    console.error("STDOUT:");
    process.stderr.write(e.stdout);
    throw err;
  }
}

/**
 * Runs a command in the example, retrying on failure with linear backoff
 * (30s, 60s, 90s, ...). Used to ride out transient 5xx responses when terraform
 * downloads providers during `cdktn get`.
 *
 * @param {string} command The lerna script to run in the example.
 * @param {number} [attempts=5] Maximum number of attempts before giving up.
 * @param {number} [backoffSeconds=30] Base delay in seconds; multiplied by
 *   the attempt number for linear backoff.
 * @returns {Promise<void>} Resolves when the command succeeds; rejects with
 *   the last error if every attempt fails.
 */
async function runWithRetry(command, attempts = 5, backoffSeconds = 30) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await runInExample(command);
    } catch (error) {
      if (attempt === attempts) throw error;
      const delaySeconds = attempt * backoffSeconds;
      console.error(
        `${command} attempt ${attempt} failed, retrying in ${delaySeconds}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
    }
  }
}

async function main() {
  await runInExample(`reinstall`);
  await runWithRetry(`build`);
  await runInExample(`beforeSynth`);
  await runInExample(`synth`);
}

(async function catchUnhandledRejections() {
  try {
    await main();
  } catch (e) {
    console.log("Failed to build example (check logs above!)");
    console.error(e.message);
    process.exitCode = 1; // just set the exit code and let Node terminate when it's down printing logs
  }
})();
