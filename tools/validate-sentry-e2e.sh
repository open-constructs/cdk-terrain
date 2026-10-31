#!/usr/bin/env bash
# Copyright (c) HashiCorp, Inc
# SPDX-License-Identifier: MPL-2.0
#
# End-to-end check of cdktn-cli telemetry on the real esbuild bundle: builds a
# throwaway copy of it with a local-sink DSN, runs convert (success), a failing
# synth (error), two hand-written stacks (stack metrics) and a crashing
# command (entrypoint failure path), then asserts on what reached
# tools/sentry-sink.mjs. The shipped bundle is never touched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUTDIR="$ROOT/packages/cdktn-cli/bundle-e2e"
CDKTN="$OUTDIR/bin/cdktn.js"

# convert --language typescript never reads dist, so `pnpm build` is enough.
for output in \
  packages/@cdktn/commons/build/index.js \
  packages/@cdktn/cli-core/build/lib/index.js \
  packages/@cdktn/hcl2json/build/index.js \
  packages/@cdktn/hcl2json/main.wasm.gz \
  packages/@cdktn/hcl2cdk/build/index.js \
  packages/cdktn/lib/index.js; do
  [ -f "$ROOT/$output" ] || { echo "FAIL: $output is missing; run pnpm build first" >&2; exit 1; }
done

SINK_LOG="$(mktemp)"
E2E_HOME="$(mktemp -d)"
SINK_PID=""

cleanup() {
  local status=$?
  if [ -n "$SINK_PID" ]; then
    kill "$SINK_PID" 2>/dev/null || true
    wait "$SINK_PID" 2>/dev/null || true
  fi
  rm -rf "$OUTDIR" "$SINK_LOG" "$E2E_HOME"
  exit "$status"
}
trap cleanup EXIT

echo "==> starting sentry sink"
node "$ROOT/tools/sentry-sink.mjs" "${1:-0}" >"$SINK_LOG" 2>&1 &
SINK_PID=$!
PORT=""
for _ in $(seq 1 50); do
  PORT="$(sed -n 's/.*listening on http:\/\/localhost:\([0-9]*\).*/\1/p' "$SINK_LOG" | head -1)"
  [ -n "$PORT" ] && break
  sleep 0.1
done
[ -n "$PORT" ] || { cat "$SINK_LOG" >&2; echo "FAIL: sink did not start" >&2; exit 1; }
DSN="http://cdktn@localhost:${PORT}/1"

echo "==> building a scratch bundle with DSN $DSN baked in"
(cd "$ROOT/packages/cdktn-cli" && pnpm run compile-build-config >/dev/null && SENTRY_DSN="$DSN" CDKTN_BUNDLE_OUTDIR="$OUTDIR" node build-config/build.js)

# Polls the sink until every pattern was recorded or 10 s pass; a timeout
# names what never arrived instead of leaving it to the assertions below.
await_items() {
  local i pattern missing
  for i in $(seq 1 100); do
    ITEMS="$(curl -sf "http://localhost:${PORT}/__items" || true)"
    missing=""
    for pattern in "$@"; do
      echo "$ITEMS" | grep -q -- "$pattern" || missing="$missing $pattern"
    done
    [ -z "$missing" ] && return 0
    sleep 0.1
  done
  echo "FAIL: timed out waiting for$missing" >&2
  exit 1
}

WORK="$(mktemp -d)"
pushd "$WORK" >/dev/null
unset CHECKPOINT_DISABLE
# An empty home makes the first run mint the anonymous install id checked below.
export CDKTF_HOME="$E2E_HOME"
# Sentry env vars a user or CI may export; none of their values may be sent.
export SENTRY_ENVIRONMENT="LEAK-ENV-SENTRY"
export SENTRY_TRACE="0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-1"
export SENTRY_BAGGAGE="sentry-environment=LEAK-BAGGAGE-SENTRY"
printf '{ "language": "typescript", "app": "true", "projectId": "e2e-validation", "sendCrashReports": true, "sendUsageTelemetry": true }' > cdktf.json

echo "==> SUCCESS trigger: cdktn convert"
echo 'resource "null_resource" "x" {}' | node "$CDKTN" convert --language typescript >/dev/null

echo "==> ERROR trigger: cdktn synth (failing app)"
node "$CDKTN" synth --app "node -e 'process.exit(1)'" >/dev/null 2>&1 || true

popd >/dev/null
rm -rf "$WORK"

STACK_WORK="$(mktemp -d)"
pushd "$STACK_WORK" >/dev/null
printf '{ "language": "typescript", "app": "node fake-app.js", "projectId": "e2e-validation", "sendCrashReports": true, "sendUsageTelemetry": true, "terraformProviders": ["aws@~>5.0"] }' > cdktf.json
cat > fake-app.js <<'JS'
const fs = require("fs");
const path = require("path");
const outdir = process.env.CDKTF_OUTDIR;
const aws = { source: "aws", version: "~> 5.0" };
const random = { source: "hashicorp/random", version: "3.6.0" };
const stacks = {
  "E2E-SECRET-STACK-NAME": {
    metadata: {
      overrides: { aws_s3_bucket: ["tags"] },
      imports: { aws_s3_bucket: ["e2e-secret-resource-id"] },
    },
    providers: {
      aws,
      random,
      vault: { source: "tfe.leak-host.example/leak-org/vault", version: "~> 3.0" },
      local: { source: "./leak-provider" },
    },
  },
  "E2E-SECRET-STACK-NAME-2": { metadata: {}, providers: { aws, random } },
};
const manifest = { version: "0.0.0-e2e", stacks: {} };
for (const [name, { metadata, providers }] of Object.entries(stacks)) {
  fs.mkdirSync(path.join(outdir, "stacks", name), { recursive: true });
  fs.writeFileSync(
    path.join(outdir, "stacks", name, "cdk.tf.json"),
    JSON.stringify({
      "//": {
        metadata: { version: "0.0.0-e2e", stackName: name, backend: "local", ...metadata },
        outputs: {},
      },
      terraform: { required_providers: providers },
    }),
  );
  manifest.stacks[name] = {
    name,
    constructPath: name,
    workingDirectory: `stacks/${name}`,
    synthesizedStackPath: `stacks/${name}/cdk.tf.json`,
    stackMetadataPath: `stacks/${name}/metadata.json`,
    annotations: [],
    dependencies: [],
  };
}
fs.writeFileSync(path.join(outdir, "manifest.json"), JSON.stringify(manifest));
JS

echo "==> STACK trigger: cdktn synth (two hand-written stacks)"
node "$CDKTN" synth --check-code-maker-output=false >/dev/null \
  || { echo "FAIL: the stack trigger synth exited non-zero; an unrelated synth regression also fails here" >&2; exit 1; }

popd >/dev/null
rm -rf "$STACK_WORK"

# A corrupt synthesized stack read with --skip-synth is an unexpected error
# that reaches runCli's failure reporter: crash event + cli.command.error.
CRASH_WORK="$(mktemp -d)"
pushd "$CRASH_WORK" >/dev/null
mkdir -p cdktf.out/stacks/broken
printf '{ "language": "typescript", "app": "true", "projectId": "e2e-validation", "sendCrashReports": true, "sendUsageTelemetry": true }' > cdktf.json
printf '{ "version": "0.0.0-e2e", "stacks": { "broken": { "name": "broken", "constructPath": "broken", "workingDirectory": "stacks/broken", "synthesizedStackPath": "stacks/broken/cdk.tf.json", "stackMetadataPath": "stacks/broken/metadata.json", "annotations": [], "dependencies": [] } } }' > cdktf.out/manifest.json
printf '{ not json' > cdktf.out/stacks/broken/cdk.tf.json

echo "==> CRASH trigger: cdktn output --skip-synth (corrupt cdk.tf.json)"
node "$CDKTN" output --skip-synth >/dev/null 2>&1 || true

popd >/dev/null
rm -rf "$CRASH_WORK"

await_items 'cli.command.invoked' 'cli.command.completed' 'cli.command.error' '"cli.stack.provider"' '"type":"event"'
RAW="$(curl -sf "http://localhost:${PORT}/__raw")"
echo "==> sink recorded: $ITEMS"

fail() { echo "FAIL: $1" >&2; exit 1; }

echo "$ITEMS" | grep -q '"binary"' \
  || fail "binary attribute missing on the command metrics"

# Every run counts once as invoked at start, then once as completed or error:
# the four triggers above, sorted as "<metric> <command>".
RUNS="$(node -e '
  const runs = [];
  for (const item of JSON.parse(process.argv[1])) {
    for (const metric of item.metrics ?? []) {
      if (metric.name.startsWith("cli.command.")) {
        runs.push(`${metric.name} ${metric.attributes.command}`);
      }
    }
  }
  console.log(runs.sort().join("\n"));
' "$ITEMS")"
EXPECTED_RUNS="$(printf '%s\n' \
  'cli.command.completed convert' \
  'cli.command.completed synth' \
  'cli.command.error output' \
  'cli.command.error synth' \
  'cli.command.invoked convert' \
  'cli.command.invoked output' \
  'cli.command.invoked synth' \
  'cli.command.invoked synth')"
[ "$RUNS" = "$EXPECTED_RUNS" ] \
  || fail "run metrics differ from one invoked per run plus one completed or error; got:
$RUNS"

# Stack metrics are aggregated per run: one item per distinct identity, its
# value the number of stacks sharing it and its counts summed over them.
# Sorted as "<metric> <identity> <value>".
STACK_METRICS="$(node -e '
  const lines = [];
  for (const item of JSON.parse(process.argv[1])) {
    for (const { name, value, attributes } of item.metrics ?? []) {
      if (name.startsWith("cli.stack")) {
        const identity =
          attributes.provider ?? attributes.resource_type ?? attributes.backend;
        const sums =
          name === "cli.stack"
            ? ` overrides=${attributes.override_count} imports=${attributes.import_count}`
            : "";
        lines.push(`${name} ${identity} ${value}${sums}`);
      }
    }
  }
  console.log(lines.sort().join("\n"));
' "$ITEMS")"
EXPECTED_STACK_METRICS="$(printf '%s\n' \
  'cli.stack local 2 overrides=1 imports=1' \
  'cli.stack.override aws_s3_bucket 1' \
  'cli.stack.provider hashicorp/aws 2' \
  'cli.stack.provider hashicorp/random 2' \
  'cli.stack.provider other 1' \
  'cli.stack.provider private-registry 1')"
[ "$STACK_METRICS" = "$EXPECTED_STACK_METRICS" ] \
  || fail "stack metrics differ from one item per distinct backend, provider and overridden type; got:
$STACK_METRICS"
for key in binding library_version; do
  echo "$ITEMS" | grep -q "\"$key\"" \
    || fail "$key attribute missing on the stack metrics"
done

# The only identity on the wire: the random install id minted into CDKTF_HOME,
# a fixed server name and a fixed environment, on every metric and the event.
USER_ID="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).userId' "$E2E_HOME/config.json" 2>/dev/null)" \
  || fail "no install id was minted into CDKTF_HOME"
[[ "$USER_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || fail "the install id in CDKTF_HOME is not a random UUID: $USER_ID"
IDENTITIES="$(node -e '
  const seen = new Set();
  for (const item of JSON.parse(process.argv[1])) {
    for (const { attributes } of item.metrics ?? []) {
      seen.add(
        `metric ${attributes["user.id"]} ${attributes["server.address"]} ${attributes["sentry.environment"]}`,
      );
    }
    if (item.type === "event") seen.add(`event ${JSON.stringify(item.event)}`);
  }
  console.log([...seen].sort().join("\n"));
' "$ITEMS")"
EXPECTED_IDENTITIES="$(printf '%s\n' \
  "event {\"server_name\":\"cdktn-cli\",\"environment\":\"production\",\"user\":{\"id\":\"$USER_ID\"}}" \
  "metric $USER_ID cdktn-cli production")"
[ "$IDENTITIES" = "$EXPECTED_IDENTITIES" ] \
  || fail "user, server name or environment differ from the install id, cdktn-cli and production; got:
$IDENTITIES"

HOST="$(uname -n)"
HOST="${HOST%%.*}"
USERNAME="$(id -un)"
[ -n "$HOST" ] && [ -n "$USERNAME" ] || fail "cannot determine the hostname and username to scan for"
for secret in E2E-SECRET-STACK-NAME e2e-secret-resource-id leak-host.example leak-org leak-provider LEAK-ENV-SENTRY LEAK-BAGGAGE-SENTRY 0af7651916cd43dd8448eb211c80319c "$HOST" "$WORK" "$STACK_WORK" "$CRASH_WORK" "$E2E_HOME"; do
  if echo "$RAW" | grep -qF -- "$secret"; then
    fail "$secret reached the sink: stack names, resource ids, provider hosts/paths, SENTRY_* env values, the hostname and the working directories must never be sent"
  fi
done
# The crash event's stack frames name the bundle's own files by absolute path,
# which may sit under a home directory; the username may appear nowhere else.
if echo "${RAW//"$OUTDIR"/}" | grep -qwF -- "$USERNAME"; then
  fail "the username $USERNAME reached the sink outside the bundle's install path"
fi
echo "$RAW" | grep -q '"error_type":{"value":"unexpected"' \
  || fail "the crash trigger was not counted as an unexpected cli.command.error"
echo "$RAW" | grep -q '"converted_lines"' \
  || fail "the convert scalars did not ride on cli.command.completed"

# A cheap bundle scan; the sink assertions above are what prove the transport.
HASHICORP_REFS="$(grep -rl "checkpoint-api.hashicorp.com" "$OUTDIR/bin" || true)"
[ -z "$HASHICORP_REFS" ] || fail "bundle still references checkpoint-api.hashicorp.com: $HASHICORP_REFS"

echo "PASS: success-path, error-path, per-stack and entrypoint-failure telemetry delivered to the local sink"
