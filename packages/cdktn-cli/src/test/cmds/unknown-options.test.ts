// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import execa from "execa";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import cdktnCliPkg from "../../../package.json";

const cdktnCliRoot = path.resolve(__dirname, "../../..");
const cdktnBin = path.resolve(cdktnCliRoot, cdktnCliPkg.bin.cdktn);
const bundleExists = fs.existsSync(path.join(cdktnCliRoot, "bundle/bin"));

// Needs the bundled CLI, which `build` produces
const describeIfBundleExists = bundleExists ? describe : describe.skip;

describeIfBundleExists("unknown options", () => {
  let cwd: string;

  beforeAll(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-unknown-options-"));
    // the marker is built at runtime, so it only shows up if the app really ran
    fs.writeFileSync(
      path.join(cwd, "cdktf.json"),
      JSON.stringify({
        language: "typescript",
        app: "node -e \"console.log('APP_WAS' + '_RUN')\"",
      }),
    );
  });

  afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const run = (args: string[], env: Record<string, string> = {}) =>
    execa(cdktnBin, args, { cwd, reject: false, env, extendEnv: true });

  it("rejects an unknown option, prints the usage and does not run the command", async () => {
    const result = await run(["synth", "--skip-synth-typo"]);

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain("APP_WAS_RUN");
    expect(output).toContain("Unknown argument: skip-synth-typo");
    expect(output).toContain("cdktn synth");
    expect(output).toContain("--app");
  });

  it("accepts synth --show-performance-info", async () => {
    const result = await run(["synth", "--show-performance-info"]);
    expect(result.stdout + result.stderr).not.toContain("Unknown argument");
  });

  it.each([
    ["synth", "--no-color"],
    ["synth", "--color"],
    ["get", "--no-color"],
    ["deploy", "--color"],
  ])("accepts %s %s, which chalk reads from argv", async (command, flag) => {
    const result = await run([command, flag, "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("Unknown argument");
  });

  it("reports a mistyped command instead of blaming a valid flag", async () => {
    const result = await run(["deploi", "--auto-approve"]);
    const output = result.stdout + result.stderr;

    expect(result.exitCode).toBe(1);
    expect(output).toContain('Could not find command "deploi"');
    expect(output).not.toContain("Unknown argument");
  });

  it.each(["synth", "init", "login"])(
    "ignores unrelated CDKTF_ environment variables for %s",
    async (command) => {
      const result = await run([command, "--help"], {
        CDKTF_DISABLE_LOGGING: "true",
        CDKTF_HOME: os.tmpdir(),
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).not.toContain("Unknown argument");
    },
  );

  it("still completes stack names for shell completion requests", async () => {
    // completing stacks reads the manifest of a synthesized app
    fs.mkdirSync(path.join(cwd, "cdktf.out"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "cdktf.out/manifest.json"),
      JSON.stringify({
        version: "0.0.0",
        stacks: {
          first: {
            name: "first",
            constructPath: "first",
            workingDirectory: "stacks/first",
            synthesizedStackPath: "stacks/first/cdk.tf.json",
            annotations: [],
            dependencies: [],
          },
        },
        backends: {},
      }),
    );

    const result = await run(["--get-yargs-completions", "cdktn", "diff"]);

    expect(result.stdout).toContain('first:target stack "first"');
    expect(result.stdout + result.stderr).not.toContain("Unknown argument");
    expect(result.exitCode).toBe(0);
  });
});
