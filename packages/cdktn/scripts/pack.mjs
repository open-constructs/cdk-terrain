/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

// Build the cdktn language packages via jsii-pacmak.
//
// Why this script exists:
//   cdktn ships its runtime deps (json-stable-stringify, semver, yazl) inside the published tarball so JSII pacmak can
//   embed them in the Python/Java/Go/.NET targets — the embedded JS needs them at runtime in user environments where
//   there is no `npm install`.
//
//   Under pnpm's default isolated layout, those deps inside packages/cdktn/node_modules are symlinks back into
//   ../../node_modules/.pnpm/<dep>/. When `npm pack` (called by jsii-pacmak) walks the symlinks, it produces tarball
//   entries with `..`-escape paths that most tar extractors discard, leaving the bundled deps' transitives missing in
//   the published tarballs.
//
//   This script sidesteps the issue by copying cdktn's source into a staging directory and running `npm install
//   --omit=dev` there. npm produces a regular nested node_modules layout (no symlinks), which jsii-pacmak + `npm pack`
//   can bundle correctly. Outputs are copied back to packages/cdktn/dist/.

import { execFileSync } from "node:child_process";
import { rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { pacmak } from "jsii-pacmak";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(__dirname, "..");
// npm ships as a .cmd shim on Windows, and Node refuses to spawn .cmd/.bat
// files directly (CVE-2024-27980 hardening -> spawnSync EINVAL). Route npm
// through a shell there so cmd.exe resolves the shim; no-op elsewhere.
const NPM_SPAWN_OPTS = process.platform === "win32" ? { shell: true } : {};
const stagingDir = join(packageDir, ".pack-staging");
const distOutDir = join(packageDir, "dist");

/**
 * Run a command synchronously, inheriting stdio and logging the invocation.
 * Throws on non-zero exit.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptionsWithBufferEncoding} [opts]
 */
function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, {
    stdio: "inherit",
    cwd: packageDir,
    ...opts,
  });
}

/**
 * Use `npm pack --dry-run --json` to discover the file list npm would publish and return it as relative paths from
 * `packageDir`. Drops any `..`-escape paths that come from npm following pnpm's node_modules symlinks — those are
 * the broken entries the staging copy will replace with a clean `npm install`.
 *
 * @returns {string[]} relative paths from packageDir
 */
function resolveSourceFiles() {
  console.log("Resolving cdktn's file list via `npm pack --dry-run`...");
  const packJson = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageDir,
    ...NPM_SPAWN_OPTS,
  }).toString();
  // npm <=11 reports an array of packed packages; npm >=12 reports an object
  // keyed by package name. Accept either so this is npm-version agnostic.
  const parsed = JSON.parse(packJson);
  const packInfo = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const files = packInfo.files
    .map((f) => f.path)
    .filter((p) => !p.includes(".."));
  console.log(`  ${files.length} source files to copy.`);
  return files;
}

/**
 * Recreate the staging directory empty.
 */
function prepareStagingDir() {
  console.log(`Preparing staging dir at ${stagingDir}...`);
  // maxRetries covers EBUSY/EPERM from a watcher still holding a handle here.
  rmSync(stagingDir, { recursive: true, force: true, maxRetries: 5 });
  mkdirSync(stagingDir, { recursive: true });
}

/**
 * Remove the staging tree once its dist/ has been moved out, so it cannot be
 * left behind holding a nested package.json and node_modules.
 *
 * Best effort: a file watcher may still hold handles inside it on Windows, and
 * a leftover tree must not fail an otherwise successful package run. The
 * `.pack-staging` entry in .npmignore keeps a stale tree from breaking the next
 * `npm pack`, and the one in .nxignore keeps the nx daemon from watching it.
 */
function cleanStagingDir() {
  try {
    rmSync(stagingDir, { recursive: true, force: true, maxRetries: 5 });
  } catch (err) {
    console.warn(`Could not remove staging dir ${stagingDir}: ${err.message}`);
  }
}

/**
 * Copy the resolved source files into the staging directory, preserving relative paths.
 *
 * @param {string[]} sourceFiles relative paths from packageDir
 */
function copySourceFiles(sourceFiles) {
  for (const relPath of sourceFiles) {
    const src = join(packageDir, relPath);
    const dst = join(stagingDir, relPath);
    if (!existsSync(src)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
  }
}

/**
 * Install runtime dependencies into the staging directory using npm. Produces a flat/nested node_modules layout (no
 * pnpm symlinks) suitable for npm pack.
 *
 * Flags:
 *   --omit=dev:           skip devDependencies (jest, jsii, typescript, ...).
 *   --omit=optional:      skip optional deps.
 *   --no-package-lock:    don't pollute staging with a fresh lockfile.
 *   --prefer-offline:     use the local npm cache before the network.
 *   --ignore-scripts:     don't run install scripts of bundled deps; bundling needs the tree on disk only.
 */
function installRuntimeDeps() {
  console.log("Installing runtime deps into staging via npm...");
  run(
    "npm",
    [
      "install",
      "--omit=dev",
      "--omit=optional",
      "--no-package-lock",
      "--prefer-offline",
      "--ignore-scripts",
    ],
    { cwd: stagingDir, ...NPM_SPAWN_OPTS },
  );
}

/**
 * Run jsii-pacmak against the staging directory via its programmatic API. Avoids spawning a Node subprocess and lets
 * static analysers see the jsii-pacmak dependency.
 *
 * @param {string[]} targets jsii-pacmak target names; empty = all.
 */
async function runJsiiPacmak(targets) {
  console.log("Running jsii-pacmak from staging...");
  await pacmak({
    inputDirectories: [stagingDir],
    ...(targets.length > 0 ? { targets } : {}),
  });
}

/**
 * Run go-copyright-header.sh against the staging output. Operates on dist/go/ so needs to run from where dist/ landed
 * (the staging dir).
 */
function runGoCopyrightHeader() {
  const script = join(stagingDir, "go-copyright-header.sh");
  if (!existsSync(script)) return;
  console.log("Running go-copyright-header.sh from staging...");
  run("bash", ["./go-copyright-header.sh"], { cwd: stagingDir });
}

/**
 * Move the produced dist/ from staging back to the package's dist/. Replaces any prior content.
 */
function moveDistOut() {
  const stagingDist = join(stagingDir, "dist");
  if (!existsSync(stagingDist)) {
    console.error(`No dist/ produced in staging at ${stagingDist}`);
    process.exit(1);
  }
  console.log(`Moving staging dist/ to ${distOutDir}...`);
  rmSync(distOutDir, { recursive: true, force: true });
  cpSync(stagingDist, distOutDir, { recursive: true });
}

const targets = process.argv.slice(2);
const sourceFiles = resolveSourceFiles();
prepareStagingDir();
copySourceFiles(sourceFiles);
installRuntimeDeps();
await runJsiiPacmak(targets);
runGoCopyrightHeader();
moveDistOut();
cleanStagingDir();
console.log("Done.");
