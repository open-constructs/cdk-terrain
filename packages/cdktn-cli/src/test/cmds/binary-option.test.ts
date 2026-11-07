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

// The synth app is a child process, so it sees the binary every later step runs
describeIfBundleExists("binary selection", () => {
  let cwd: string;

  const project = (targetVersions?: Record<string, string>) => {
    fs.writeFileSync(
      path.join(cwd, "cdktf.json"),
      JSON.stringify({
        language: "typescript",
        app: "node -e \"console.log('BINARY=' + process.env.TERRAFORM_BINARY_NAME)\"",
        targetVersions,
      }),
    );
  };

  const binarySeenBy = async (
    args: string[],
    env: Record<string, string> = {},
  ) => {
    const { TERRAFORM_BINARY_NAME: _, ...parentEnv } = process.env;
    const result = await execa(cdktnBin, ["synth", ...args], {
      cwd,
      reject: false,
      env: { ...parentEnv, ...env },
      extendEnv: false,
    });
    return (result.stdout + result.stderr).match(/BINARY=(\S+)/)?.[1];
  };

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-binary-"));
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it("prefers --binary to TERRAFORM_BINARY_NAME and to the targets", async () => {
    project({ opentofu: ">=1.6.0" });
    expect(
      await binarySeenBy(["--binary", "my-tofu"], {
        TERRAFORM_BINARY_NAME: "other",
      }),
    ).toBe("my-tofu");
  });

  // The cases of the selection itself are covered in commons; this is the startup wiring
  it("runs tofu for a project that targets only OpenTofu", async () => {
    project({ opentofu: ">=1.6.0" });
    expect(await binarySeenBy([])).toBe("tofu");
  });
});
