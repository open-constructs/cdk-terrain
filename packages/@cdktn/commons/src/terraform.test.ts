// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

const PROBE_KEY = Symbol.for("cdktn.terraformCli");

// The binary name is read at import, so every case loads a fresh module with
// TERRAFORM_BINARY_NAME pointing at a fixture script; the probe itself is
// cached on globalThis and reset per test.
function loadProbe(binary: string) {
  const original = process.env.TERRAFORM_BINARY_NAME;
  process.env.TERRAFORM_BINARY_NAME = binary;
  try {
    let terraform: typeof import("./terraform");
    let sentry: typeof import("@sentry/node");
    jest.isolateModules(() => {
      terraform = jest.requireActual("./terraform");
      sentry = jest.requireActual("@sentry/node");
    });
    return { ...terraform!, sentry: sentry! };
  } finally {
    if (original === undefined) delete process.env.TERRAFORM_BINARY_NAME;
    else process.env.TERRAFORM_BINARY_NAME = original;
  }
}

describe("terraform binary probe", () => {
  let fixtureDir: string;
  const originalCheckpointDisable = process.env.CHECKPOINT_DISABLE;

  function fakeBinary(name: string, output: string): string {
    const file = path.join(fixtureDir, name);
    const calls = path.join(fixtureDir, `${name}.calls`);
    fs.writeFileSync(
      file,
      `#!/bin/sh\necho x >> "${calls}"\nprintf '%s\\n' "${output}"\n`,
      { mode: 0o755 },
    );
    return file;
  }

  function spawnCount(binary: string): number {
    const calls = `${binary}.calls`;
    return fs.existsSync(calls)
      ? fs.readFileSync(calls, "utf8").trim().split("\n").length
      : 0;
  }

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-tf-probe-"));
    delete (globalThis as any)[PROBE_KEY];
    delete process.env.CHECKPOINT_DISABLE;
  });

  afterEach(() => {
    fs.removeSync(fixtureDir);
    delete (globalThis as any)[PROBE_KEY];
    if (originalCheckpointDisable === undefined) {
      delete process.env.CHECKPOINT_DISABLE;
    } else {
      process.env.CHECKPOINT_DISABLE = originalCheckpointDisable;
    }
  });

  it("recognizes Terraform from the first line of `version`", async () => {
    const { terraformCli, terraformVersion } = loadProbe(
      fakeBinary(
        "terraform",
        "Terraform v1.12.6\non darwin_arm64\n\nYour version of Terraform is out of date!",
      ),
    );
    await expect(terraformCli()).resolves.toEqual({
      name: "terraform",
      version: "1.12.6",
    });
    await expect(terraformVersion()).resolves.toBe("1.12.6");
  });

  it("recognizes OpenTofu from the first line of `version`", async () => {
    const { terraformCli, terraformVersion } = loadProbe(
      fakeBinary("tofu", "OpenTofu v1.8.1\non linux_amd64"),
    );
    await expect(terraformCli()).resolves.toEqual({
      name: "opentofu",
      version: "1.8.1",
    });
    await expect(terraformVersion()).resolves.toBe("1.8.1");
  });

  it("reports an unrecognized product as unknown", async () => {
    const { terraformCli } = loadProbe(
      fakeBinary("other", "SomethingElse v2.0.0"),
    );
    await expect(terraformCli()).resolves.toEqual({
      name: "unknown",
      version: "2.0.0",
    });
  });

  it("spawns the binary once per process, on first use, across module copies", async () => {
    const binary = fakeBinary("terraform", "Terraform v1.12.6");
    const first = loadProbe(binary);
    const second = loadProbe(binary);
    expect(spawnCount(binary)).toBe(0);

    await Promise.all([
      first.terraformCli(),
      second.terraformCli(),
      first.terraformVersion(),
      second.terraformVersion(),
    ]);
    await expect(second.terraformCli()).resolves.toMatchObject({
      name: "terraform",
    });
    expect(spawnCount(binary)).toBe(1);
  });

  it("resolves to missing (never rejects) and counts no cli.error when the binary cannot be spawned", async () => {
    const { terraformCli, terraformVersion, sentry } = loadProbe(
      path.join(fixtureDir, "does-not-exist"),
    );
    const count = jest.spyOn(sentry.metrics, "count");

    await expect(terraformCli()).resolves.toEqual({ name: "missing" });
    // `cdktn debug` prints this value as-is
    await expect(terraformVersion()).resolves.toMatch(
      /^Error: Usage Error: Unknown: Error loading terraform version/,
    );
    expect(count).not.toHaveBeenCalled();
  });
});
