/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

const { execSync } = require("child_process");
const { readFileSync, writeFileSync } = require("fs");

// The `typescript` template is scaffolded first and supplies every shared file, including the Terraform Cloud
// rewrite of main.ts. This hook only installs dependencies with pnpm and prints the help text.
const packageManager = "pnpm";

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

  pinPackageManager();

  if (!silent) {
    console.log(readFileSync("./help", "utf-8"));
  }
};

/**
 * Record the package manager that just installed the dependencies, so corepack reproduces it for everyone working
 * on the project. The version is read at scaffold time rather than baked into the template, which would go stale
 * with every release.
 */
function pinPackageManager() {
  let version;
  try {
    version = execSync(`${packageManager} --version`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return;
  }

  // Anything but a plain version (a corepack passthrough message, say) is not safe to pin.
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    return;
  }

  const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
  pkg.packageManager = `${packageManager}@${version}`;
  writeFileSync("./package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
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
