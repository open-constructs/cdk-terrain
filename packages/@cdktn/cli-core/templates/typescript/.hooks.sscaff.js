/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

const { execSync } = require("child_process");
const { cpSync, readFileSync, writeFileSync } = require("fs");
const path = require("path");

// pnpm-workspace.yaml approves dependency build scripts with `allowBuilds`, which older versions ignore.
const minimumPnpmVersion = [10, 26];

exports.pre = (ctx) => {
  if (ctx.packageManager === "pnpm") {
    requirePnpm();
  } else {
    requirePackageManager("npm");
  }
};

exports.post = (ctx) => {
  const silent = ctx.silent === "true" || ctx.silent === true;
  // Terraform Cloud configuration settings if the organization name and workspace is set.
  if (ctx.OrganizationName != "") {
    if (!silent) {
      console.log(
        `\nGenerating Terraform Cloud configuration for '${ctx.OrganizationName}' organization and '${ctx.WorkspaceName}' workspace.....`
      );
    }
    terraformCloudConfig(
      ctx.$base,
      ctx.OrganizationName,
      ctx.WorkspaceName,
      ctx.TerraformRemoteHostname
    );
  }

  const npm_cdktf = ctx.npm_cdktf;
  if (!npm_cdktf) {
    throw new Error(`missing context "npm_cdktf"`);
  }

  // A variant (a sibling template directory such as typescript-pnpm) contributes the files this template lacks,
  // and they have to be in place before the install below reads them.
  if (ctx.variant) {
    cpSync(path.join(__dirname, "..", ctx.variant), ".", { recursive: true });
  }

  // `constructs@10` resolves to the newest 10.x, which satisfies the `^10.6.0`
  // peer range cdktn declares; that peer range is the real constraint, so
  // only the major here has to follow cdktn's.
  installDeps(ctx.pmAdd, [npm_cdktf, `constructs@10`], false, silent);
  // Capped below 7.x: that is the native port, which jsii does not support yet.
  installDeps(
    ctx.pmAdd,
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

  if (ctx.packageManager === "pnpm") {
    pinPackageManager("pnpm", packageManagerVersion("pnpm"));
  }

  if (!silent) {
    console.log(readFileSync("./help", "utf-8"));
  }
};

function requirePackageManager(packageManager) {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    execSync(`${probe} ${packageManager}`, { stdio: "ignore" });
  } catch {
    throw new Error(
      `Could not find "${packageManager}" on your PATH. Install it (e.g. "corepack enable ${packageManager}") and run cdktn init again.`
    );
  }
}

function requirePnpm() {
  const version = packageManagerVersion("pnpm");
  if (!version) {
    throw new Error(
      `Could not find "pnpm" on your PATH. Install it (e.g. "corepack enable pnpm") and run cdktn init again.`
    );
  }
  const [major, minor] = version.split(".").map(Number);
  const [minMajor, minMinor] = minimumPnpmVersion;
  if (major < minMajor || (major === minMajor && minor < minMinor)) {
    throw new Error(
      `pnpm ${version} is too old: this template needs pnpm ${minMajor}.${minMinor} or newer.`
    );
  }
}

/**
 * Record the package manager that just installed the dependencies, so corepack reproduces it for everyone working
 * on the project. The version is read at scaffold time rather than baked into the template, which would go stale
 * with every release.
 */
function pinPackageManager(packageManager, version) {
  if (!version) {
    return;
  }

  const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
  pkg.packageManager = `${packageManager}@${version}`;
  writeFileSync("./package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
}

function packageManagerVersion(packageManager) {
  let version;
  try {
    version = execSync(`${packageManager} --version`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }

  // Anything but a plain version (a corepack passthrough message, say) is not safe to rely on.
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
    ? version
    : undefined;
}

function installDeps(pmAdd, deps, isDev, silent) {
  const devDep = isDev ? "-D" : "";
  // make sure we're installing dev dependencies as well
  const env = Object.assign({}, process.env);
  env["NODE_ENV"] = "development";

  // Each spec is double-quoted so ranges containing spaces or shell
  // metacharacters survive the shell. Double quotes (rather than single) work
  // on both POSIX shells and cmd.exe, where an unquoted `^` is the escape
  // character and would silently turn `cdktn@^1.2.3` into `cdktn@1.2.3`.
  const specs = deps.map((dep) => `"${dep}"`).join(" ");

  execSync(`${pmAdd} ${devDep} ${specs}`, {
    stdio: silent ? "ignore" : "inherit",
    env,
  });
}

function terraformCloudConfig(
  baseName,
  organizationName,
  workspaceName,
  terraformRemoteHostname
) {
  template = readFileSync("./main.ts", "utf-8");

  result = template.replace(
    `import { App, TerraformStack } from "cdktn";`,
    `import { App, TerraformStack, CloudBackend, NamedCloudWorkspace } from "cdktn";`
  );
  result = result.replace(
    `new MyStack(app, "${baseName}");`,
    `const stack = new MyStack(app, "${baseName}");
new CloudBackend(stack, {
  hostname: "${terraformRemoteHostname}",
  organization: "${organizationName}",
  workspaces: new NamedCloudWorkspace("${workspaceName}")
});`
  );

  writeFileSync("./main.ts", result, "utf-8");
}
