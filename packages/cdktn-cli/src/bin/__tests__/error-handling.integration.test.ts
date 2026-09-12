// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
//
// Bundles a tiny fixture with esbuild and runs it as a separate Node process,
// so runCli() meets the runtime's real unhandled-rejection behaviour. Not
// dist-gated: no prebuilt CLI, terraform or network is needed.
import { spawn } from "child_process";
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

  // cdktn.ts' completion function, minus the manifest: answers for "diff"
  // only after a turn of the event loop
  const customCompletion = function (_current, argv, completionsFilter, done) {
    if (argv._.includes("diff")) {
      completionsFilter(async (_err, defaults) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        done([...defaults, 'alpha:target stack "alpha"']);
      });
    } else {
      completionsFilter();
    }
  };

  const cli = yargs(process.argv.slice(2).filter((a) => a !== "--with-listener"))
    .exitProcess(false)
    .completion("completion", customCompletion)
    .command(
      "diff [stack]",
      "diffs a stack",
      (cmdYargs) =>
        cmdYargs.positional("stack", { type: "string", desc: "the stack" }),
      () => {},
    )
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
    )
    .command(
      "capturedok",
      "succeeds after queueing an event, like a usage metric would",
      () => {},
      async () => {
        Sentry.captureMessage("empirical-success-message");
        console.log("capturedok-done");
      },
    )
    .command(
      "pipedok",
      "prints one line, then waits for stdin to end before returning",
      () => {},
      async () => {
        console.log("pipedok-first-line");
        // lets the test close its end of the stdout pipe before the success
        // path drains stdio
        await new Promise((resolve) => {
          process.stdin.once("end", resolve);
          process.stdin.resume();
        });
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

// A sink that accepts the envelope connection and never answers: the
// transport's request then keeps the event loop alive until something exits
// the process explicitly.
function startSilentSentrySink(): Promise<{
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}> {
  let connections = 0;
  return new Promise((resolve) => {
    const server = http.createServer(() => {
      connections += 1;
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        connections: () => connections,
        close: () =>
          new Promise((res) => {
            server.closeAllConnections();
            server.close(() => res());
          }),
      });
    });
  });
}

function expectNoRuntimeNoise(output: string) {
  expect(output).not.toContain("ERR_UNHANDLED_REJECTION");
  expect(output).not.toContain("UnhandledPromiseRejection");
  expect(output).not.toContain("PromiseRejectionHandledWarning");
  expect(output).not.toContain("Warning:");
  expect(output).not.toContain("Node.js v");
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
    // resolves: one Sentry client.
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

  it("delivers the crash to Sentry before the process exits", async () => {
    const sink = await startSentrySink();
    try {
      const dsn = `http://public@127.0.0.1:${sink.port}/1`;
      const result = await execa(
        process.execPath,
        [bundlePath, "capturedboom"],
        { env: { ...process.env, TEST_SENTRY_DSN: dsn }, reject: false },
      );

      // the process exits only after reportFailure awaited the flush, so
      // everything it delivered has already reached the sink
      expect(result.exitCode).toBe(1);
      const bodies = sink
        .requests()
        .filter((r) => r.url.includes("/envelope/"))
        .map((r) => r.body);
      expect(bodies.length).toBeGreaterThan(0);
      expect(bodies.some((b) => b.includes("empirical-sentry-message"))).toBe(
        true,
      );
    } finally {
      await sink.close();
    }
  }, 15000);

  it("exits 0 within the flush bound when the ingest endpoint never answers on the success path", async () => {
    const sink = await startSilentSentrySink();
    try {
      const dsn = `http://public@127.0.0.1:${sink.port}/1`;
      const started = Date.now();
      const result = await execa(process.execPath, [bundlePath, "capturedok"], {
        env: { ...process.env, TEST_SENTRY_DSN: dsn },
        reject: false,
      });
      const elapsedMs = Date.now() - started;
      const output = `${result.stdout}\n${result.stderr}`;

      // the hung request would keep the loop alive forever; the bounded
      // flush (4 s) plus the explicit exit is what ends the process
      expect(result.exitCode).toBe(0);
      expect(elapsedMs).toBeLessThan(8000);
      expect(sink.connections()).toBeGreaterThan(0);
      expect(result.stdout).toContain("capturedok-done");
      expectNoRuntimeNoise(output);
    } finally {
      await sink.close();
    }
  }, 15000);

  it("exits 0 when the stdout reader closes before the success path drains stdio", async () => {
    // `cdktn --help | head -1`: the reader is gone by the time the drain
    // writes, so that write gets EPIPE and Node emits 'error' on stdout
    const child = spawn(process.execPath, [bundlePath, "pipedok"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const firstChunk = await new Promise<string>((resolve) => {
      child.stdout.setEncoding("utf8");
      child.stdout.once("data", resolve);
    });
    child.stdout.destroy(); // closes the read end: every later write is EPIPE
    child.stdin.end(); // only now may the handler return and the drain run
    const [exitCode] = await new Promise<[number | null, string | null]>(
      (resolve) =>
        child.once("close", (code, signal) => resolve([code, signal])),
    );

    expect(firstChunk).toContain("pipedok-first-line");
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("EPIPE");
    expectNoRuntimeNoise(stderr);
  }, 15000);

  it("prints the completions of an asynchronous completion function", async () => {
    // `cdktn diff <TAB>`: yargs does not await the completion callback, so
    // parseAsync resolves before an async completion function has printed
    const result = await execa(
      process.execPath,
      [bundlePath, "--get-yargs-completions", "fixture", "diff", ""],
      { reject: false },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('alpha:target stack "alpha"');
    expect(result.stdout).toContain("--help");
    expectNoRuntimeNoise(`${result.stdout}\n${result.stderr}`);
  }, 15000);

  it("exits 1 within the flush bound when the ingest endpoint never answers on the failure path", async () => {
    const sink = await startSilentSentrySink();
    try {
      const dsn = `http://public@127.0.0.1:${sink.port}/1`;
      const started = Date.now();
      const result = await execa(
        process.execPath,
        [bundlePath, "capturedboom"],
        { env: { ...process.env, TEST_SENTRY_DSN: dsn }, reject: false },
      );
      const elapsedMs = Date.now() - started;
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.exitCode).toBe(1);
      expect(elapsedMs).toBeLessThan(8000);
      expect(sink.connections()).toBeGreaterThan(0);
      expect(output).toContain("empirical-sentry-message");
      expectNoRuntimeNoise(output);
    } finally {
      await sink.close();
    }
  }, 15000);
});
