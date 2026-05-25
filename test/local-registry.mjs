#!/usr/bin/env node
/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

// Manage a local Verdaccio registry used by run-against-dist.
//
// Usage:
//   node local-registry.mjs start <config.yaml>   # starts verdaccio, waits until ready, writes state to a side-channel file
//   node local-registry.mjs stop                  # stops the registry started by `start` and restores npm registry URL

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(tmpdir(), "cdk-terrain-local-registry.json");
const REGISTRY_HOST = "localhost:4873";
const REGISTRY_URL = `http://${REGISTRY_HOST}`;
const PING_URL = `${REGISTRY_URL}/-/ping`;
const READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_MS = 250;

const [, , command, configArg] = process.argv;

if (command === "start") {
  if (!configArg) {
    console.error("Usage: local-registry.mjs start <config.yaml>");
    process.exit(2);
  }
  await start(resolve(configArg));
} else if (command === "stop") {
  stop();
} else {
  console.error(`Unknown command: ${command ?? "<none>"}`);
  console.error("Usage: local-registry.mjs (start <config.yaml> | stop)");
  process.exit(2);
}

/**
 * Spawn Verdaccio in the background, wait until it answers `/-/ping`, then point npm at it and write a state file so a
 * later `stop` can clean up. Exits the process with status 1 if Verdaccio fails to become ready (either because the
 * child crashed or the readiness deadline elapsed).
 *
 * @param {string} configPath Absolute path to verdaccio.yaml.
 * @returns {Promise<void>}
 */
async function start(configPath) {
  if (!existsSync(configPath)) {
    console.error(`Verdaccio config not found: ${configPath}`);
    process.exit(1);
  }

  const storageDir = join(dirname(configPath), "storage");
  console.log(`Cleaning storage dir (${storageDir})..`);
  rmSync(storageDir, { recursive: true, force: true });

  const logDir = mkdtempSync(join(tmpdir(), "verdaccio-"));
  const logPath = join(logDir, "verdaccio.log");
  const logFd = openSync(logPath, "w");
  console.log(`Verdaccio Registry log file: ${logPath}`);

  const originalRegistry = npmGetRegistry();

  const child = spawn("npm", ["exec", "-c", `verdaccio -c ${configPath}`], {
    cwd: SCRIPT_DIR,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();

  let exited = false;
  let exitInfo = null;
  child.on("exit", (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });

  console.log("Waiting for local Registry to start");
  const ready = await waitForReady(() => exited);
  if (!ready) {
    const tail = safeReadTail(logPath, 4000);
    if (exited) {
      console.error(
        `Verdaccio exited before becoming ready (code=${exitInfo?.code}, signal=${exitInfo?.signal}).`,
      );
    } else {
      console.error(
        `Verdaccio did not become ready within ${READINESS_TIMEOUT_MS}ms.`,
      );
      try {
        // Negative PID targets the whole process group.
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
    if (tail) {
      console.error("--- verdaccio log (tail) ---");
      console.error(tail);
      console.error("----------------------------");
    }
    process.exit(1);
  }

  npmSetRegistry(REGISTRY_URL);
  appendAuthToken();

  writeFileSync(
    STATE_FILE,
    JSON.stringify({ pid: child.pid, originalRegistry, logPath }, null, 2),
  );
}

/**
 * Restore the original npm registry URL and SIGTERM the Verdaccio process recorded in the state file. Safe to call when
 * no registry is running — the state file's absence is treated as a no-op.
 *
 * @returns {void}
 */
function stop() {
  if (!existsSync(STATE_FILE)) return;
  let state;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    unlinkSync(STATE_FILE);
    return;
  }

  if (state.originalRegistry) {
    npmSetRegistry(state.originalRegistry);
  }
  if (state.pid) {
    try {
      // Negative PID targets the whole process group.
      process.kill(-state.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  unlinkSync(STATE_FILE);
}

/**
 * Poll Verdaccio's `/-/ping` endpoint until it returns 200, the child process exits, or the readiness deadline elapses.
 * `hasExited` lets the caller short-circuit when Verdaccio has already died — otherwise polling would wait the full
 * timeout for an endpoint that will never come up.
 *
 * @param {() => boolean} hasExited Returns true if the Verdaccio child has exited.
 * @returns {Promise<boolean>} `true` if ping returned 200 before timeout, otherwise `false`.
 */
async function waitForReady(hasExited) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (hasExited()) return false;
    try {
      const res = await fetch(PING_URL, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(READINESS_POLL_MS);
  }
  return false;
}

/**
 * Promise-based delay helper.
 *
 * @param {number} ms Delay in milliseconds.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Read the currently configured npm registry URL so it can be restored on `stop`. Falls back to the public registry if
 * npm prints nothing.
 *
 * @returns {string} npm registry URL (with trailing slash).
 */
function npmGetRegistry() {
  const result = spawnSync("npm", ["config", "get", "registry"], {
    encoding: "utf8",
  });
  return (result.stdout ?? "").trim() || "https://registry.npmjs.org/";
}

/**
 * Set the npm registry URL globally via `npm config set`.
 *
 * @param {string} url Registry URL to write into the user's npm config.
 * @returns {void}
 */
function npmSetRegistry(url) {
  spawnSync("npm", ["config", "set", "registry", url], { stdio: "inherit" });
}

/**
 * Append a dummy `_authToken` for the local registry to `~/.npmrc` so `npm publish` against Verdaccio doesn't prompt
 * for credentials. Idempotent — the line is only written if it isn't already present.
 *
 * @returns {void}
 */
function appendAuthToken() {
  const npmrc = join(process.env.HOME ?? "", ".npmrc");
  if (!process.env.HOME) return;
  const line = `//${REGISTRY_HOST}/:_authToken=dummy\n`;
  try {
    const existing = existsSync(npmrc) ? readFileSync(npmrc, "utf8") : "";
    if (!existing.includes(line.trim())) {
      writeFileSync(
        npmrc,
        existing +
          (existing.endsWith("\n") || existing.length === 0 ? "" : "\n") +
          line,
      );
    }
  } catch (err) {
    console.error(`Failed to write auth token to ${npmrc}: ${err.message}`);
  }
}

/**
 * Read up to the last `maxBytes` bytes of a text file, returning `null` if the file cannot be read. Used to surface a
 * Verdaccio log tail when startup fails without crashing on a missing/locked file.
 *
 * @param {string} path File path to read.
 * @param {number} maxBytes Maximum number of trailing bytes to return.
 * @returns {string | null} File tail, or null on read error.
 */
function safeReadTail(path, maxBytes) {
  try {
    const content = readFileSync(path, "utf8");
    return content.length > maxBytes ? content.slice(-maxBytes) : content;
  } catch {
    return null;
  }
}
