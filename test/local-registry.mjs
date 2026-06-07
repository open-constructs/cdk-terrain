#!/usr/bin/env node
/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

// Manage a local Verdaccio registry used by run-against-dist.
//
// Usage:
//   node local-registry.mjs start <config.yaml>   # starts verdaccio, waits until ready

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { runServer } from "verdaccio";

const REGISTRY_HOST = "localhost:4873";
const REGISTRY_URL = `http://${REGISTRY_HOST}`;

const [, , command, configArg] = process.argv;

if (command === "start") {
  if (!configArg) {
    console.error("Usage: local-registry.mjs start <config.yaml>");
    process.exit(2);
  }
  await start(resolve(configArg));
} else {
  console.error(`Unknown command: ${command ?? "<none>"}`);
  console.error("Usage: local-registry.mjs start <config.yaml>");
  process.exit(2);
}

/**
 * Run Verdaccio and point npm at it.
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

  const originalRegistry = npmGetRegistry();

  const restoreAndExit = (signal) => {
    console.log(
      `Received ${signal}, restoring npm registry to ${originalRegistry}..`,
    );
    if (originalRegistry) {
      npmSetRegistry(originalRegistry);
    }
    process.exit(0);
  };
  process.once("SIGINT", () => restoreAndExit("SIGINT"));
  process.once("SIGTERM", () => restoreAndExit("SIGTERM"));

  const app = await runServer(configPath);

  console.log("Waiting for local Registry to start");
  try {
    await new Promise((resolve, reject) => {
      app.once("error", reject);
      app.listen(4873, () => resolve());
    });
  } catch (err) {
    console.error(
      `Failed to start local registry on ${REGISTRY_URL}: ${err.stack}`,
    );
    process.exit(1);
  }

  npmSetRegistry(REGISTRY_URL);
  appendAuthToken();
}

/**
 * Read the currently configured npm registry URL so it can be restored when we're done. Falls back to the public registry if
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
