// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import execa from "execa";
import path from "path";
import { promises as fs } from "fs";
import { mkdtemp } from "@cdktn/commons";
import cdktnCliPkg from "../../../package.json";

const cdktnCliRoot = path.resolve(__dirname, "../../..");
const cdktfBin = path.resolve(cdktnCliRoot, cdktnCliPkg.bin.cdktn);
const input = `
resource "null_resource" "dummy" {}
`;

/**
 * Environment for the spawned CLI with FORCE_COLOR removed.
 *
 * The test runner (nx) sets FORCE_COLOR when attached to a TTY. The CLI sets
 * NO_COLOR for its own output, and Node warns on stderr when both are set:
 * "The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set."
 * That warning breaks the assertions below that stderr is empty, so drop
 * FORCE_COLOR rather than loosening them.
 */
function envWithoutForceColor(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  return env;
}

describe("convert command", () => {
  it("proposes specifying a provider version", async () => {
    await mkdtemp(async (cwd) => {
      await fs.writeFile(
        path.resolve(cwd, "cdktf.json"),
        JSON.stringify({ terraformProviders: [] }),
      );
      const result = await execa(cdktfBin, ["convert"], {
        stdio: "pipe",
        cwd,
        input,
        env: envWithoutForceColor(),
        extendEnv: false,
      });
      expect(result.stderr).toEqual("");
      expect(result.stdout).toContain(
        `The following providers are missing schema information and might need manual adjustments to synthesize correctly`,
      );
      expect(result.stdout).toContain(
        `import { Resource } from "./.gen/providers/null/resource";`,
      );
      expect(result.stdout).toContain(`new Resource(this, "dummy", {});`);
    });
  }, 30_000);
  it("reads provider version from existing cdktf.json", async () => {
    await mkdtemp(async (cwd) => {
      await fs.writeFile(
        path.resolve(cwd, "cdktf.json"),
        JSON.stringify({ terraformProviders: ["hashicorp/null@~> 3.0"] }),
      );
      const result = await execa(cdktfBin, ["convert"], {
        stdio: "pipe",
        cwd,
        input,
        env: envWithoutForceColor(),
        extendEnv: false,
      });
      expect(result.stderr).toEqual("");
      expect(result.stdout).not.toContain(
        `The following providers are missing schema information and might need manual adjustments to synthesize correctly`,
      );
      expect(result.stdout).toContain(
        `import { Resource } from "./.gen/providers/null/resource";`,
      );
      expect(result.stdout).toContain(`new Resource(this, "dummy", {});`);
    });
  }, 30_000);
  it("works if no cdktf.json could be found", async () => {
    await mkdtemp(async (cwd) => {
      const result = await execa(cdktfBin, ["convert"], {
        stdio: "pipe",
        cwd,
        input,
        env: envWithoutForceColor(),
        extendEnv: false,
      });
      expect(result.stderr).toEqual("");
      expect(result.stdout).toContain(
        `The following providers are missing schema information and might need manual adjustments to synthesize correctly`,
      );
      expect(result.stdout).toContain(
        `import { Resource } from "./.gen/providers/null/resource";`,
      );
      expect(result.stdout).toContain(`new Resource(this, "dummy", {});`);
    });
  }, 30_000);

  it("works with a singular provider flag passed", async () => {
    await mkdtemp(async (cwd) => {
      const result = await execa(
        cdktfBin,
        ["convert", "--provider=kubernetes"],
        {
          stdio: "pipe",
          cwd,
          env: envWithoutForceColor(),
          extendEnv: false,
          input: `resource "kubernetes_deployment" "myapp" {
            metadata {
              name = "myapp-frontend-dev"
              labels = {
                app = "myapp"
                component = "frontend"
                environment = "dev"
              }
            }
          
            spec {
              replicas = "1"
          
              selector {
                match_labels = {
                  app = "myapp"
                  component = "frontend"
                  environment = "dev"
                }
              }
          
              template {
                metadata {
                  labels = {
                    app = "myapp"
                    component = "frontend"
                    environment = "dev"
                  }
                }
          
                spec {
                  container {
                    image = "nginx:latest"
                    name  = "myapp-frontend-dev"
                    # ports {
                    #   containerPort = 80
                    # }
                  }
                }
              }
            }
          }`,
        },
      );
      expect(result.stderr).toEqual("");
      expect(result.stdout).not.toContain(
        `The following providers are missing schema information and might need manual adjustments to synthesize correctly`,
      );
      expect(result.stdout).toContain(
        `import { Deployment } from "./.gen/providers/kubernetes/deployment";`,
      );
      expect(result.stdout).toContain(`new Deployment(this, "myapp", {`);
      expect(result.stdout).toContain(`template: {`);
    });
  }, 30_000);

  it("works with multiple provider flag passed", async () => {
    await mkdtemp(async (cwd) => {
      const result = await execa(
        cdktfBin,
        ["convert", "--provider=kubernetes", "--provider=null"],
        {
          stdio: "pipe",
          cwd,
          env: envWithoutForceColor(),
          extendEnv: false,
          input: `resource "kubernetes_deployment" "myapp" {
            metadata {
              name = "myapp-frontend-dev"
              labels = {
                app = "myapp"
                component = "frontend"
                environment = "dev"
              }
            }
          
            spec {
              replicas = "1"
          
              selector {
                match_labels = {
                  app = "myapp"
                  component = "frontend"
                  environment = "dev"
                }
              }
          
              template {
                metadata {
                  labels = {
                    app = "myapp"
                    component = "frontend"
                    environment = "dev"
                  }
                }
          
                spec {
                  container {
                    image = "nginx:latest"
                    name  = "myapp-frontend-dev"
                    # ports {
                    #   containerPort = 80
                    # }
                  }
                }
              }
            }
          }`,
        },
      );
      expect(result.stderr).toEqual("");
      expect(result.stdout).not.toContain(
        `The following providers are missing schema information and might need manual adjustments to synthesize correctly`,
      );
      expect(result.stdout).toContain(
        `import { Deployment } from "./.gen/providers/kubernetes/deployment";`,
      );
      expect(result.stdout).toContain(`new Deployment(this, "myapp", {`);
      expect(result.stdout).toContain(`template: {`);
    });
  }, 30_000);
});
