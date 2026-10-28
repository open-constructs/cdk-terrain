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

  it("declares --show-performance-info on synth", async () => {
    const result = await run(["synth", "--help"]);
    expect(result.stdout + result.stderr).toContain("--show-performance-info");
  });

  // --help makes yargs skip the check, so these pair the flag under test with a bad one:
  // the check has to run, report the bad flag and must not mention the accepted one
  it.each([
    ["synth", "--no-color", "no-color"],
    ["synth", "--color", "color"],
    ["get", "--no-color", "no-color"],
    ["deploy", "--color", "color"],
  ])(
    "accepts %s %s, which chalk reads from argv",
    async (command, flag, name) => {
      const result = await run([command, flag, "--bogus"]);
      const output = result.stdout + result.stderr;

      expect(result.exitCode).toBe(1);
      expect(output).toContain("Unknown argument: bogus");
      expect(output).not.toContain(`Unknown argument: ${name}`);
      expect(output).not.toMatch(
        new RegExp(`Unknown arguments?:.*\\b${name}\\b`),
      );
    },
  );

  it("reports a mistyped command instead of blaming a valid flag", async () => {
    const result = await run(["deploi", "--auto-approve"]);
    const output = result.stdout + result.stderr;

    expect(result.exitCode).toBe(1);
    expect(output).toContain('Could not find command "deploi"');
    expect(output).not.toContain("Unknown argument");
  });

  it("reports a mistyped subcommand instead of blaming a valid flag", async () => {
    const result = await run(["provider", "bogus", "--force-local"]);
    const output = result.stdout + result.stderr;

    expect(output).not.toContain("Unknown argument");
    expect(output).toContain(
      "A set of subcommands that facilitates provider management",
    );
  });

  it("still rejects an unknown option of a subcommand", async () => {
    const result = await run(["provider", "add", "aws", "--bogus"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain("Unknown argument: bogus");
  });

  it.each(["synth", "init", "login"])(
    "ignores unrelated CDKTF_ environment variables for %s",
    async (command) => {
      const result = await run([command, "--bogus"], {
        CDKTF_DISABLE_LOGGING: "true",
        CDKTF_HOME: os.tmpdir(),
      });
      const output = result.stdout + result.stderr;

      expect(result.exitCode).toBe(1);
      expect(output).toContain("Unknown argument: bogus");
      expect(output).not.toContain("disableLogging");
      expect(output).not.toContain("disable-logging");
      expect(output).not.toMatch(/Unknown arguments?:.*\bhome\b/);
    },
  );

  it("points to TF_CLI_ARGS instead of forwarding terraform flags", async () => {
    const result = await run(["synth", "--parallelism-typo=3"]);
    expect(result.stdout + result.stderr).toContain("TF_CLI_ARGS_<command>");
  });

  it("reports a single dash long flag as written", async () => {
    const result = await run(["synth", "-target=aws_s3_bucket.a"]);
    const output = result.stdout + result.stderr;

    expect(result.exitCode).toBe(1);
    expect(output).toContain(
      "Unknown argument: -target=aws_s3_bucket.a (did you mean --target=aws_s3_bucket.a?)",
    );
    expect(output).not.toMatch(/Unknown arguments?: [a-z],/);
  });

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
