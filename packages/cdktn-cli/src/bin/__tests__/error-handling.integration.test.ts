// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
//
// Child-process smoke test for runCli(): bundles a tiny fixture with esbuild
// (already a devDependency) and runs it as a real, separate Node process, so
// this exercises the actual unhandled-rejection behaviour of the runtime
// rather than a mocked one. Deliberately NOT dist-gated (no prebuilt CLI, no
// terraform, no network) so it runs in normal CI. Bundling takes well under
// a second.
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import * as esbuild from "esbuild";
import execa from "execa";

function fixtureSource(errorHandlingPath: string): string {
  return `
  import yargs from "yargs";
  import * as Sentry from "@sentry/node";
  import { runCli } from ${JSON.stringify(errorHandlingPath)};

  if (process.argv.includes("--with-listener")) {
    // stands in for Sentry's OnUnhandledRejection integration: if runCli()
    // ever orphans a rejection, this would be the thing that catches it.
    process.on("unhandledRejection", (reason) => {
      console.error("stub-sentry-caught:", reason);
    });
  }

  // Points the SDK at a local sink instead of sentry.io, standing in for
  // the initializErrorReporting() call every real command handler makes
  // (see cli-core's error-reporting.ts) before runCli() can ever report.
  if (process.env.TEST_SENTRY_DSN) {
    Sentry.init({ dsn: process.env.TEST_SENTRY_DSN, autoSessionTracking: false });
  }

  const cli = yargs(process.argv.slice(2).filter((a) => a !== "--with-listener"))
    .exitProcess(false)
    .command(
      "rawboom",
      "throws an async raw string",
      () => {},
      async () => {
        throw "raw-string-message";
      },
    )
    .command(
      "capturedboom",
      "throws an async Error that should reach Sentry",
      () => {},
      async () => {
        throw new Error("empirical-sentry-message");
      },
    );

  void runCli(cli);
`;
}

// A minimal stand-in for Sentry's ingest endpoint: records every request it
// receives so the test can assert an actual envelope was delivered over the
// wire, not just that some in-process function was called.
function startSentrySink(): Promise<{
  port: number;
  requests: () => { url: string; body: string }[];
  close: () => Promise<void>;
}> {
  const requests: { url: string; body: string }[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({
          url: req.url || "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        requests: () => requests,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

describe("runCli child-process smoke test", () => {
  let bundlePath: string;

  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cdktn-error-handling-fixture-"),
    );
    const fixturePath = path.join(tmpDir, "fixture.ts");
    bundlePath = path.join(tmpDir, "fixture.bundle.js");

    const errorHandlingPath = path
      .resolve(__dirname, "../error-handling.ts")
      .replace(/\.ts$/, "");
    fs.writeFileSync(fixturePath, fixtureSource(errorHandlingPath));

    // The fixture lives under os.tmpdir(), which has no node_modules
    // ancestry of its own, so bare-specifier resolution for its direct
    // imports (yargs, @sentry/node) needs a hand-rolled alias. Everything
    // error-handling.ts itself imports (yargs, @sentry/node, @cdktn/commons)
    // resolves normally, because that file's real path is inside the
    // workspace; aliasing both here just pins the fixture's copy to the
    // same resolved module, so there's one Sentry client instance, not two.
    await esbuild.build({
      entryPoints: [fixturePath],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundlePath,
      alias: {
        yargs: require.resolve("yargs"),
        "@sentry/node": require.resolve("@sentry/node"),
      },
    });
  });

  it("prints a raw-string handler rejection exactly once and never crashes the process", async () => {
    const result = await execa(process.execPath, [bundlePath, "rawboom"], {
      reject: false,
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).toBe(1);
    expect(output.split("raw-string-message").length - 1).toBe(1);
    expect(output).not.toContain("ERR_UNHANDLED_REJECTION");
    expect(output).not.toContain("UnhandledPromiseRejection");
    expect(output).not.toContain("PromiseRejectionHandledWarning");
    expect(output).not.toContain("Node.js v");
  });

  it("still orphans nothing when a Sentry-style unhandledRejection listener is installed", async () => {
    const result = await execa(
      process.execPath,
      [bundlePath, "rawboom", "--with-listener"],
      { reject: false },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).toBe(1);
    expect(output.split("raw-string-message").length - 1).toBe(1);
    expect(output).not.toContain("stub-sentry-caught");
    expect(output).not.toContain("ERR_UNHANDLED_REJECTION");
    expect(output).not.toContain("UnhandledPromiseRejection");
    expect(output).not.toContain("PromiseRejectionHandledWarning");
    expect(output).not.toContain("Node.js v");
  });

  it("delivers the crash to Sentry before the process exits", async () => {
    const sink = await startSentrySink();
    try {
      const dsn = `http://public@127.0.0.1:${sink.port}/1`;
      const result = await execa(
        process.execPath,
        [bundlePath, "capturedboom"],
        { env: { ...process.env, TEST_SENTRY_DSN: dsn }, reject: false },
      );

      // The process only exits after reportFailure() awaits closeSentry(),
      // so if the flush actually delivered the event, the sink has already
      // seen it by the time execa resolves - there is nothing left to poll.
      expect(result.exitCode).toBe(1);
      const envelopeRequests = sink
        .requests()
        .filter((r) => r.url.includes("/envelope/"));
      expect(envelopeRequests.length).toBeGreaterThan(0);
      expect(
        envelopeRequests.some((r) =>
          r.body.includes("empirical-sentry-message"),
        ),
      ).toBe(true);
    } finally {
      await sink.close();
    }
  }, 15000);
});
