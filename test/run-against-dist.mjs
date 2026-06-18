#!/usr/bin/env node
/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

// Build a throwaway install of cdktn-cli from `dist/js` against a local
// Verdaccio registry, put it on PATH, then run the command passed as args
// (e.g. `npx jest --runInBand typescript`) against that install.
//
// Usage:
//   ./run-against-dist.mjs <command> [args...]

import { access, glob, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// execa (over child_process.spawn) resolves `.cmd`/`.bat` shims and quotes args
// correctly on Windows.
import execa from "execa";

import { runServer } from "verdaccio";

const scriptdir = import.meta.dirname;
const cdktnDist = resolve(scriptdir, "..", "dist");
const cdktnRoot = resolve(scriptdir, "..");
const VERDACCIO_CONFIG = join(scriptdir, "verdaccio.yaml");
const cwd = process.cwd();

// URL of our local Verdaccio instance
const REGISTRY_URL = "http://localhost:4873/";

// `npm publish` refuses with ENEEDAUTH unless it has a token for the target
// registry, even though Verdaccio allows anonymous publishing. Pass a dummy one
// inline as npm's per-registry config key.
const NPM_AUTH_ARG = `--${REGISTRY_URL.replace(/^https?:/, "")}:_authToken=dummy`;

process.env.CDKTF_DIST = cdktnDist;

/** @type {import("node:http").Server | null} */
let server = null;
/** @type {Promise<void> | null} */
let stopPromise = null;

/**
 * Shut down the in-process Verdaccio server. Idempotent — safe to call from the
 * happy path, error handlers, and signal handlers alike.
 *
 * @returns {Promise<void>}
 */
function stopRegistry() {
  // Memoize so concurrent callers (e.g. a signal arriving mid-shutdown) await
  // the same shutdown rather than racing past it to process.exit().
  stopPromise ??= (async () => {
    if (server) {
      await new Promise((res) => server.close(() => res()));
      server = null;
    }
  })();
  return stopPromise;
}

/**
 * Abort with a message and a non-zero exit code, cleaning up the registry first.
 *
 * @param {string} message Error text to print to stderr.
 * @returns {Promise<never>}
 */
async function fail(message) {
  console.error(message);
  await stopRegistry();
  process.exit(1);
}

/**
 * Async existence check.
 *
 * @param {string} path Filesystem path to test.
 * @returns {Promise<boolean>} Whether the path exists.
 */
async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Stop the server if we're interrupted.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.log(`Received ${signal}, cleaning up..`);
    void stopRegistry().finally(() => process.exit(1));
  });
}

let exitCode = 1;
try {
  // Start the local npm registry (Verdaccio).
  await startRegistry();

  // The JS dist is always required — this script publishes cdktn-cli from
  // dist/js and the CLI drives every language's tests. Per-language dists are
  // only consumed by the jest tests passed in via args, so missing ones surface
  // as clear test failures rather than blocking the whole run.
  if (!(await pathExists(join(cdktnDist, "js")))) {
    console.error(
      "ERROR: unable to find the 'js' subdirectory in the 'dist' directory",
    );
    await fail(
      "Did you run 'pnpm run package' (or 'pnpm run package:js') to create the 'dist' directory?",
    );
  }

  for (const lang of ["python", "java", "dotnet", "go"]) {
    if (!(await pathExists(join(cdktnDist, lang)))) {
      console.warn(
        `WARNING: dist/${lang} is missing — tests for that language will fail. Run 'pnpm run package:${lang}' if you need it.`,
      );
    }
  }

  console.log("Publishing CLI from 'dist'...");
  // Forward-slash pattern: fs.glob treats "\" as an escape, so a path.join()
  // pattern wouldn't match on Windows.
  const tgzGlob = join(cdktnDist, "js", "*.tgz").replaceAll("\\", "/");
  for await (const pkg of glob(tgzGlob)) {
    console.log(pkg);
    try {
      await execa(
        "npm",
        ["publish", `--registry=${REGISTRY_URL}`, NPM_AUTH_ARG, "--force", pkg],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
    } catch {
      await fail(`npm publish failed for ${pkg}`);
    }
  }

  // Install the CLI from dist/js in a temporary area and add to path.
  console.log("Installing CLI from 'dist'...");
  const staging = await mkdtemp(join(tmpdir(), "cdktn-cli-"));
  await execa("npm", ["init", "-y"], {
    cwd: staging,
    stdio: ["ignore", "inherit", "inherit"],
  });

  // Use the same package manager (and version) the rest of the repo uses.
  const packageManager = JSON.parse(
    await readFile(join(cdktnRoot, "package.json"), "utf8"),
  ).packageManager;
  const packageManagerName = packageManager.split("@")[0];
  await execa("corepack", ["use", packageManager], {
    cwd: staging,
    stdio: ["ignore", "inherit", "inherit"],
  });

  // There's only one version in our local registry, so we don't need to specify
  // a version here. Retry to ride out transient ECONNRESETs from Verdaccio's
  // upstream fetch.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await execa(
        packageManagerName,
        ["add", "cdktn-cli", `--registry=${REGISTRY_URL}`],
        { cwd: staging, stdio: ["ignore", "inherit", "inherit"] },
      );
      break;
    } catch {
      if (attempt === 3) {
        await fail("CLI install failed after 3 attempts");
      }
      console.log(
        `CLI install attempt ${attempt} failed, retrying in ${attempt * 10}s...`,
      );
      await sleep(attempt * 10 * 1000);
    }
  }

  // Shut down the local registry now that the CLI is installed. The test run
  // uses the host's real npm registry (we never modified it), so tests that
  // install an older cdktn from NPM resolve it normally.
  await stopRegistry();

  const testPathCdktnCli = join(staging, "node_modules", ".bin");
  process.env.TEST_PATH_CDKTN_CLI = testPathCdktnCli;
  process.env.PATH = `${testPathCdktnCli}${delimiter}${process.env.PATH}`;

  let version;
  try {
    version = await execa("cdktn", ["--version"]);
  } catch (err) {
    console.error(err.stdout ?? "");
    console.error(err.stderr ?? "");
    await fail(
      "ERROR: 'cdktn --version' failed after install. See the output above for the underlying error.",
    );
  }
  console.log(`Installed CDKTN-CLI version: ${version.stdout.trim()}`);

  // Run the requested command from the original working directory.
  const [command, ...commandArgs] = process.argv.slice(2);
  if (!command) {
    await fail("ERROR: no command provided to run against the dist install");
  }

  try {
    const result = await execa(command, commandArgs, {
      cwd,

      // Forward stdin, stdout, and stderr to command.
      stdio: "inherit",
    });
    exitCode = result.exitCode ?? 0;
  } catch (err) {
    // The command ran but exited non-zero (e.g. failing tests) — propagate its
    // code rather than treating it as an unexpected error.
    exitCode = err.exitCode ?? 1;
  }
} finally {
  // Always shut down the registry, even if an unexpected error aborts the run.
  await stopRegistry();
}

process.exit(exitCode);

/**
 * Clean Verdaccio's storage and boot it on the well-known port.
 *
 * Awaiting `runServer` + `listen` is the readiness signal: `runServer` resolves
 * only after Verdaccio finishes its own init, and the `listen` callback fires
 * once the HTTP server is accepting connections — so no ping/poll is needed.
 *
 * @returns {Promise<void>}
 */
async function startRegistry() {
  if (!(await pathExists(VERDACCIO_CONFIG))) {
    await fail(`Verdaccio config not found: ${VERDACCIO_CONFIG}`);
  }

  const storageDir = join(scriptdir, "storage");
  console.log(`Cleaning storage dir (${storageDir})..`);
  await rm(storageDir, { recursive: true, force: true });

  console.log("Starting local registry...");
  const app = await runServer(VERDACCIO_CONFIG);

  try {
    server = await new Promise((resolve, reject) => {
      const s = app.listen(4873, () => resolve(s));
      s.once("error", reject);
    });
  } catch (err) {
    await fail(
      `Failed to start local registry on ${REGISTRY_URL}: ${err.stack}`,
    );
  }
}
