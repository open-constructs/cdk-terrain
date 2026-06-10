#!/usr/bin/env node
// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
//
// Minimal local Sentry "sink" for end-to-end validation of the cdktn-cli
// telemetry pipeline (see specledger/002-remove-hashicorp-telemetry,
// quickstart Journey 6). It accepts Sentry envelopes on
// POST /api/<project>/envelope/ and records every envelope item type (and
// metric names for trace_metric items).
//
// Usage: node tools/sentry-sink.mjs [port=9999]
//   GET /__items  -> JSON array of recorded items
//   GET /__reset  -> clears recorded items
import * as http from "node:http";
import * as zlib from "node:zlib";

const port = Number(process.argv[2] ?? 9999);
const items = [];

function recordEnvelope(body) {
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
    if (header.type === "trace_metric" && lines[i + 1]) {
      try {
        item.metricNames = JSON.parse(lines[i + 1]).items.map((m) => m.name);
      } catch {
        /* ignore malformed payloads */
      }
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
  if (req.method === "GET" && req.url === "/__reset") {
    items.length = 0;
    return res.end("ok");
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
  console.log(`[sentry-sink] listening on http://localhost:${port}`);
});
