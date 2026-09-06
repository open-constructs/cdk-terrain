/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

const { execSync } = require("child_process");
const { readFileSync, writeFileSync } = require("fs");

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

  // Mirrors the `constructs` peer dependency range declared by the cdktn
  // package. The `<10.8.0` exclusion added in #363 is gone: only 10.8.0 itself
  // was broken (it dropped `jsii.tsc.outDir`, which jsii-rosetta needs to map
  // the shipped .d.ts files back to symbol ids, so `cdktn convert` emitted
  // unresolved Java/Go imports). 10.8.1 restored the field, is deprecated-free
  // and is the higher version, so no range resolver will ever pick 10.8.0.
  installDeps([npm_cdktf, `constructs@10`], false, silent);
  installDeps(
    ["@types/node", "typescript@5.x", "jest", "@types/jest", "ts-jest", "ts-node"],
    true,
    silent
  );

  if (!silent) {
    console.log(readFileSync("./help", "utf-8"));
  }
};

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

  execSync(`npm install ${devDep} ${specs}`, {
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
