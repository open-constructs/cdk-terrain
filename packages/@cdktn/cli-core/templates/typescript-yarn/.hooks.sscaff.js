/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

const { execSync } = require("child_process");
const { readFileSync, writeFileSync } = require("fs");

// The `typescript` template is scaffolded first and supplies every shared file, including the Terraform Cloud
// rewrite of main.ts. This hook only installs dependencies with yarn and prints the help text.
const packageManager = "yarn";

exports.pre = () => {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    execSync(`${probe} ${packageManager}`, { stdio: "ignore" });
  } catch {
    throw new Error(
      `Could not find "${packageManager}" on your PATH. Install it (e.g. "corepack enable ${packageManager}") and run cdktn init again.`
    );
  }
};

exports.post = (ctx) => {
  const silent = ctx.silent === "true" || ctx.silent === true;

  const npm_cdktf = ctx.npm_cdktf;
  if (!npm_cdktf) {
    throw new Error(`missing context "npm_cdktf"`);
  }

  // Pin before installing: a bare `yarn` behind a corepack shim resolves to the EOL 1.22 default until the project
  // declares a version, so the pin is what selects a modern Yarn for the install below.
  pinPackageManager(silent);

  // `constructs@10` resolves to the newest 10.x, which satisfies the `^10.6.0`
  // peer range cdktn declares; that peer range is the real constraint, so
  // only the major here has to follow cdktn's.
  installDeps([npm_cdktf, `constructs@10`], false, silent);
  // Capped below 7.x: that is the native port, which jsii does not support yet.
  installDeps(
    [
      "@types/node",
      "typescript@>=5.0.0 <7.0.0",
      "jest",
      "@types/jest",
      "ts-jest",
      "tsx",
    ],
    true,
    silent
  );

  if (!silent) {
    console.log(readFileSync("./help", "utf-8"));
  }
};

/** Read a version from a command, returning "" when it fails or prints anything other than a plain version. */
function readVersion(command) {
  let out;
  try {
    out = execSync(command, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }

  return /^\d+\.\d+\.\d+/.test(out) ? out : "";
}

/**
 * Record the Yarn version this project should use, so corepack reproduces it for everyone working on the project.
 * Versions are resolved at scaffold time rather than baked into this template, which would go stale with every
 * Yarn release.
 *
 * This runs before the install: until a project declares a version, a corepack `yarn` shim resolves to the
 * end-of-life 1.22 default, so writing the pin first is what gets a modern Yarn to perform the install.
 */
function pinPackageManager(silent) {
  const installed = readVersion(`${packageManager} --version`);
  let version = installed;

  // Yarn 1.x is end-of-life, and it is what a corepack shim reports until a project pins something. Ask the
  // registry for the current release instead of scaffolding onto the legacy line. Modern Yarn publishes as
  // @yarnpkg/cli (the `yarn` package still points at 1.x), and npm ships with Node, whereas corepack no longer
  // does from Node 26 on.
  if (!version || version.startsWith("1.")) {
    version = readVersion(`npm view @yarnpkg/cli version`) || installed;
  }

  if (!version) {
    return;
  }

  // The pin only changes which Yarn runs if corepack is managing the `yarn` shim. Without it (corepack is not
  // bundled from Node 26 on) a 1.x binary ignores `packageManager` altogether, so say so rather than leaving a
  // lockfile that silently disagrees with the pin.
  if (version !== installed && !hasCorepack()) {
    if (!silent) {
      console.log(
        `\nNote: Yarn ${installed || "1.x"} is on your PATH, but this project pins Yarn ${version}.\n` +
          `Corepack is not available to switch automatically, so the install below uses Yarn ${installed || "1.x"}.\n` +
          `Install Yarn ${version} (https://yarnpkg.com/getting-started/install) and re-run "yarn install" to match the pin.\n`
      );
    }
  }

  const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
  pkg.packageManager = `${packageManager}@${version}`;
  writeFileSync("./package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
}

/** Corepack is what makes a `packageManager` pin actually select a version. It is not bundled from Node 26 on. */
function hasCorepack() {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    execSync(`${probe} corepack`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function installDeps(deps, isDev, silent) {
  const devDep = isDev ? "-D" : "";
  // make sure we're installing dev dependencies as well
  const env = Object.assign({}, process.env);
  env["NODE_ENV"] = "development";

  // Each spec is double-quoted so ranges containing spaces or shell
  // metacharacters survive the shell. Double quotes (rather than single) work
  // on both POSIX shells and cmd.exe, where an unquoted `^` is the escape
  // character and would silently turn `cdktn@^1.2.3` into `cdktn@1.2.3`.
  const specs = deps.map((dep) => `"${dep}"`).join(" ");

  execSync(`${packageManager} add ${devDep} ${specs}`, {
    stdio: silent ? "ignore" : "inherit",
    env,
  });
}
