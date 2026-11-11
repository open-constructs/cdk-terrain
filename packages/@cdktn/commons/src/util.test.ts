// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

// Import via the package barrel so the util.ts ↔ logging.ts module-init cycle
import * as fs from "fs";
import { exec } from "./index";
import { getLogger } from "log4js";

// Silence log4js output so the test reporter shows only Jest's PASS/FAIL lines.
beforeAll(() => {
  getLogger().level = "OFF";
});

type DecoratedError = Error & { stderr?: string; stdout?: string };

/**
 * Spawn a failing child process and return the rejected Error.
 *
 * Using the running node binary keeps the failure surface portable across CI / dev machines (no shell builtins, no
 * external binaries). The `stderr` / `stdout` payloads are hex-encoded inside the script so the captured bytes do not
 * appear verbatim in the headline's `args.join(" ")` echo — that lets tests assert the headline does not include
 * captured output.
 *
 * @param spec what the child should write to each stream and which exit code to use
 * @returns the Error rejected by `exec`, narrowed to expose the attached `.stderr` / `.stdout`
 * @throws if `exec` resolves rather than rejecting (the test setup is wrong)
 */
async function runFailing(spec: {
  stderr?: string;
  stdout?: string;
  exitCode: number;
}): Promise<DecoratedError> {
  const parts: string[] = [];
  if (spec.stderr !== undefined) {
    const hex = Buffer.from(spec.stderr).toString("hex");
    parts.push(`process.stderr.write(Buffer.from("${hex}","hex").toString())`);
  }
  if (spec.stdout !== undefined) {
    const hex = Buffer.from(spec.stdout).toString("hex");
    parts.push(`process.stdout.write(Buffer.from("${hex}","hex").toString())`);
  }
  parts.push(`process.exit(${spec.exitCode})`);
  try {
    await exec(
      process.execPath,
      ["-e", parts.join("; ")],
      {},
      undefined,
      // No-op stderr callback suppresses exec()'s default pass-through to process.stderr.
      () => {},
    );
    throw new Error("exec() resolved unexpectedly");
  } catch (e: any) {
    return e;
  }
}

const STDERR_PAYLOAD = "stderr-payload-marker";
const STDOUT_PAYLOAD = "stdout-payload-marker";

describe("exec() failure decoration", () => {
  it("attaches both stderr and stdout and surfaces them via toString()", async () => {
    const error = await runFailing({
      stderr: STDERR_PAYLOAD,
      stdout: STDOUT_PAYLOAD,
      exitCode: 2,
    });

    expect(error.stderr).toBe(STDERR_PAYLOAD);
    expect(error.stdout).toBe(STDOUT_PAYLOAD);
    expect(error.message).toContain("exited with code 2");
    expect(error.message).not.toContain(STDERR_PAYLOAD);
    expect(error.message).not.toContain(STDOUT_PAYLOAD);
    expect(String(error)).toBe(
      `Error: ${error.message}\n${STDERR_PAYLOAD}\n${STDOUT_PAYLOAD}`,
    );
  });

  it("renders stderr-only failures without a trailing blank line for empty stdout", async () => {
    const error = await runFailing({ stderr: STDERR_PAYLOAD, exitCode: 3 });

    expect(error.stderr).toBe(STDERR_PAYLOAD);
    expect(error.stdout).toBe("");
    expect(String(error)).toBe(`Error: ${error.message}\n${STDERR_PAYLOAD}`);
  });

  it("renders stdout-only failures without a leading blank line for empty stderr", async () => {
    const error = await runFailing({ stdout: STDOUT_PAYLOAD, exitCode: 4 });

    expect(error.stderr).toBe("");
    expect(error.stdout).toBe(STDOUT_PAYLOAD);
    expect(String(error)).toBe(`Error: ${error.message}\n${STDOUT_PAYLOAD}`);
  });

  it("leaves toString() at the default headline when both streams are empty", async () => {
    const error = await runFailing({ exitCode: 5 });

    expect(error.stderr).toBe("");
    expect(error.stdout).toBe("");
    // No custom toString override → default Error.prototype.toString = "Error: <message>".
    expect(String(error)).toBe(`Error: ${error.message}`);
  });

  it("surfaces stderr and the exit code through template-literal interpolation of the error", async () => {
    const error = await runFailing({ stderr: STDERR_PAYLOAD, exitCode: 6 });

    expect(`${error}`).toContain(STDERR_PAYLOAD);
    expect(`${error}`).toContain("exited with code 6");
  });
});

describe("exec() timeout", () => {
  // A killed orphan stays a zombie where PID 1 never reaps, as in a CI container.
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      return !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return true;
    }
  };

  // A wrapper that forks the real binary instead of exec'ing it.
  it("kills what the timed-out command started", async () => {
    const parent = [
      `const c = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" })`,
      `process.stdout.write(String(c.pid))`,
      `setTimeout(() => {}, 30000)`,
    ].join("; ");

    const error: DecoratedError = await exec(
      process.execPath,
      ["-e", parent],
      { timeout: 1000 },
      undefined,
      () => {},
    ).then(
      () => {
        throw new Error("exec() resolved unexpectedly");
      },
      (e) => e,
    );
    expect(error.message).toContain("timed out after 1000ms");

    const grandchild = Number(error.stdout);
    expect(grandchild).toBeGreaterThan(0);
    for (let i = 0; i < 40 && isAlive(grandchild); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(isAlive(grandchild)).toBe(false);
  }, 10000);

  // A timed child leads its own process group and misses the terminal's
  // interrupt; with no timeout it must stay in the caller's group unless the
  // caller detaches it.
  (process.platform === "linux" ? it.each : it.skip.each)([
    ["treats an infinite timeout as none", {}, "false"],
    ["keeps a caller's detached without a timeout", { detached: true }, "true"],
  ])("%s", async (_name, options, leads) => {
    const leadsItsGroup = [
      `const [, , pgrp] = require("fs").readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")`,
      `setTimeout(() => process.stdout.write(String(pgrp === String(process.pid))), 50)`,
    ].join("; ");

    await expect(
      exec(process.execPath, ["-e", leadsItsGroup], {
        timeout: Infinity,
        ...options,
      }),
    ).resolves.toBe(leads);
  });
});
