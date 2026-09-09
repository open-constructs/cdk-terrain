// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
//
// Bundles a tiny fixture with esbuild and runs it as a separate Node process,
// so runCli() meets the runtime's real unhandled-rejection behaviour. Not
// dist-gated: no prebuilt CLI, terraform or network is needed.
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import * as esbuild from "esbuild";
import execa from "execa";

function fixtureSource(errorHandlingPath: string): string {
  return `
  import yargs from "yargs";
  import * as Sentry from "@sentry/node";
  import { Errors, setUsageTelemetryEnabled } from "@cdktn/commons";
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
    Sentry.init({
      dsn: process.env.TEST_SENTRY_DSN,
      release: "cdktn-cli-test",
      environment: "production",
      tracesSampleRate: 0,
      serverName: "cdktn-cli",
    });
  }
  if (process.env.TEST_USAGE_TELEMETRY === "1") {
    setUsageTelemetryEnabled(true);
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
        Errors.setScope("capturedboom");
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
        let body = Buffer.concat(chunks);
        if (req.headers["content-encoding"] === "gzip") {
          body = zlib.gunzipSync(body);
        }
        requests.push({ url: req.url || "", body: body.toString("utf8") });
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

type MetricItem = {
  name: string;
  attributes: Record<string, { value: unknown }>;
};

// A third copy of the envelope parser (test helper, sink, here); unifying
// them is tracked as a follow-up.
function parseMetricItems(bodies: string[]): MetricItem[] {
  const items: MetricItem[] = [];
  for (const body of bodies) {
    const lines = body.split("\n").filter(Boolean);
    for (let i = 0; i < lines.length - 1; i++) {
      let header;
      try {
        header = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (header?.type === "trace_metric") {
        items.push(...JSON.parse(lines[i + 1]).items);
      }
    }
  }
  return items;
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

    // The fixture sits under os.tmpdir() with no node_modules ancestry, so its
    // bare imports are aliased to the workspace copies error-handling.ts itself
    // resolves: one Sentry client, one telemetry state.
    await esbuild.build({
      entryPoints: [fixturePath],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundlePath,
      alias: {
        yargs: require.resolve("yargs"),
        "@sentry/node": require.resolve("@sentry/node"),
        "@cdktn/commons": require.resolve("@cdktn/commons"),
      },
    });
  }, 60000);

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

  it("delivers the failed-command metric alongside the crash in the same run", async () => {
    const sink = await startSentrySink();
    try {
      const dsn = `http://public@127.0.0.1:${sink.port}/1`;
      // the jest preset sets CHECKPOINT_DISABLE, which would gate the metric
      const { CHECKPOINT_DISABLE: _disabled, ...env } = process.env;
      const result = await execa(
        process.execPath,
        [bundlePath, "capturedboom"],
        {
          env: { ...env, TEST_SENTRY_DSN: dsn, TEST_USAGE_TELEMETRY: "1" },
          extendEnv: false,
          reject: false,
        },
      );

      // the process exits only after reportFailure awaited the flush, so
      // everything it delivered has already reached the sink
      expect(result.exitCode).toBe(1);
      const bodies = sink
        .requests()
        .filter((r) => r.url.includes("/envelope/"))
        .map((r) => r.body);
      expect(bodies.some((b) => b.includes("empirical-sentry-message"))).toBe(
        true,
      );
      const metrics = parseMetricItems(bodies);
      const error = metrics.find((m) => m.name === "cli.command.error")!;
      expect(error).toBeDefined();
      expect(error.attributes.error_type.value).toBe("unexpected");
      expect(error.attributes.command.value).toBe("capturedboom");
      expect(JSON.stringify(metrics)).not.toContain("empirical-sentry-message");
    } finally {
      await sink.close();
    }
  }, 15000);
});
