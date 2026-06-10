// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { execFile } from "child_process";
import * as fs from "fs-extra";
import * as http from "http";
import * as os from "os";
import * as path from "path";

// Gated bundle E2E (002-remove-hashicorp-telemetry, quickstart Journey 6):
// runs the REAL esbuild bundle as a child process and asserts a
// trace_metric envelope reaches a local Sentry sink — proving the DSN
// bake-in, consent gating and the bounded success-path flush end to end.
//
// Requires the bundle to be PRE-BUILT with the matching local-sink DSN:
//   (cd packages/cdktn-cli && SENTRY_DSN=http://cdktn@localhost:9999/1 \
//      node build-config/build.js)
// then run with CDKTN_SENTRY_E2E=1 (port override: CDKTN_SENTRY_E2E_PORT).
// tools/validate-sentry-e2e.sh wraps the same flow as a standalone script.

const gated = process.env.CDKTN_SENTRY_E2E ? describe : describe.skip;

gated("sentry bundle e2e", () => {
  const port = Number(process.env.CDKTN_SENTRY_E2E_PORT ?? 9999);
  const bundle = path.resolve(__dirname, "../../bundle/bin/cdktn.js");
  const items: Array<{ type: string; metricNames?: string[] }> = [];
  let server: http.Server;
  let workdir: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const lines = body.split("\n").filter(Boolean);
        for (let i = 1; i < lines.length; i++) {
          try {
            const header = JSON.parse(lines[i]);
            if (typeof header?.type !== "string") continue;
            const item: { type: string; metricNames?: string[] } = {
              type: header.type,
            };
            if (header.type === "trace_metric" && lines[i + 1]) {
              item.metricNames = JSON.parse(lines[i + 1]).items.map(
                (m: any) => m.name,
              );
            }
            items.push(item);
          } catch {
            /* not an item header */
          }
        }
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(port, resolve));
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-e2e-"));
    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      language: "typescript",
      app: "true",
      projectId: "bundle-e2e",
      sendCrashReports: true,
      sendUsageTelemetry: true,
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.removeSync(workdir);
  });

  it("delivers cli.command.invoked from `cdktn convert` (success-path flush)", async () => {
    expect(fs.existsSync(bundle)).toBe(true);

    const env = { ...process.env };
    delete env.CHECKPOINT_DISABLE;

    // async spawn: the sink runs in THIS process, so a synchronous spawn
    // would deadlock — the child's flush waits on the sink, the sink
    // waits on jest's (blocked) event loop
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [bundle, "convert", "--language", "typescript"],
        { cwd: workdir, env, timeout: 120_000 },
        (error) => (error ? reject(error) : resolve()),
      );
      child.stdin!.end('resource "null_resource" "x" {}');
    });

    const metricNames = items
      .filter((i) => i.type === "trace_metric")
      .flatMap((i) => i.metricNames ?? []);
    expect(metricNames).toContain("cli.command.invoked");
  }, 150_000);
});
