#!/usr/bin/env node
// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
//
// Local Sentry sink for tools/validate-sentry-e2e.sh: records the envelopes
// POSTed to /api/<project>/envelope/. Usage: node tools/sentry-sink.mjs [port=0]
//   port 0 picks a free port; the chosen one is printed on the first line
//   GET /__items -> recorded items as JSON; GET /__raw -> decoded envelope bodies
import * as http from "node:http";
import * as zlib from "node:zlib";

const port = Number(process.argv[2] ?? 0);
const items = [];
const bodies = [];

// Mirrors parseMetricItems in packages/@cdktn/commons/src/telemetry.test.ts:
// an envelope-format change is fixed in both.
function recordEnvelope(body) {
  bodies.push(body);
  const lines = body.split("\n").filter(Boolean);
  for (let i = 1; i < lines.length; i++) {
    let header;
    try {
      header = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!header || typeof header.type !== "string") continue;
    const item = { type: header.type };
    try {
      const payload = JSON.parse(lines[i + 1]);
      if (header.type === "trace_metric") {
        item.metrics = payload.items.map((m) => ({
          name: m.name,
          value: m.value,
          attributes: Object.fromEntries(
            Object.entries(m.attributes ?? {}).map(([k, v]) => [k, v.value]),
          ),
        }));
      } else if (header.type === "event") {
        const { server_name, environment, user } = payload;
        item.event = { server_name, environment, user };
      }
    } catch {
      /* ignore malformed payloads */
    }
    items.push(item);
    console.log(`[sentry-sink] ${JSON.stringify(item)}`);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/__items") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(items));
  }
  if (req.method === "GET" && req.url === "/__raw") {
    res.setHeader("content-type", "text/plain");
    return res.end(bodies.join("\n"));
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    const encoding = req.headers["content-encoding"];
    try {
      if (encoding === "gzip") body = zlib.gunzipSync(body);
      else if (encoding === "deflate") body = zlib.inflateSync(body);
      else if (encoding === "br") body = zlib.brotliDecompressSync(body);
    } catch {
      /* fall through with the raw body */
    }
    console.log(
      `[sentry-sink] ${req.method} ${req.url} (${body.length} bytes, encoding=${encoding ?? "none"})`,
    );
    // the SDK appends auth as a query string: /api/<p>/envelope/?sentry_key=…
    if (req.method === "POST" && /\/envelope\/?(\?|$)/.test(req.url ?? "")) {
      recordEnvelope(body.toString("utf8"));
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
});

server.listen(port, () => {
  console.log(
    `[sentry-sink] listening on http://localhost:${server.address().port}`,
  );
});
