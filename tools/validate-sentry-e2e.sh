#!/usr/bin/env bash
# Copyright (c) HashiCorp, Inc
# SPDX-License-Identifier: MPL-2.0
#
# End-to-end check of cdktn-cli telemetry on the real esbuild bundle: builds a
# throwaway copy of it with a local-sink DSN, runs convert (success), a failing
# synth (error), a hand-written stack (per-stack metrics) and a crashing
# command (entrypoint failure path), then asserts on what reached
# tools/sentry-sink.mjs. The shipped bundle is never touched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTDIR="$ROOT/packages/cdktn-cli/bundle-e2e"
CDKTN="$OUTDIR/bin/cdktn.js"
SINK_LOG="$(mktemp)"
SINK_PID=""

cleanup() {
  local status=$?
  if [ -n "$SINK_PID" ]; then
    kill "$SINK_PID" 2>/dev/null || true
    wait "$SINK_PID" 2>/dev/null || true
  fi
  rm -rf "$OUTDIR" "$SINK_LOG"
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

# Polls the sink until every pattern was recorded or 10 s pass; the
# assertions at the end name whatever is still missing.
await_items() {
  local i pattern
  for i in $(seq 1 100); do
    ITEMS="$(curl -sf "http://localhost:${PORT}/__items" || true)"
    for pattern in "$@"; do
      echo "$ITEMS" | grep -q -- "$pattern" || { sleep 0.1; continue 2; }
    done
    return 0
  done
}

WORK="$(mktemp -d)"
pushd "$WORK" >/dev/null
unset CHECKPOINT_DISABLE
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
const name = "E2E-SECRET-STACK-NAME";
fs.mkdirSync(path.join(outdir, "stacks", name), { recursive: true });
fs.writeFileSync(
  path.join(outdir, "stacks", name, "cdk.tf.json"),
  JSON.stringify({
    "//": {
      metadata: {
        version: "0.0.0-e2e",
        stackName: name,
        backend: "local",
        overrides: { aws_s3_bucket: ["tags"] },
        imports: { aws_s3_bucket: ["e2e-secret-resource-id"] },
      },
      outputs: {},
    },
    terraform: {
      required_providers: {
        aws: { source: "aws", version: "~> 5.0" },
        random: { source: "hashicorp/random", version: "3.6.0" },
        vault: { source: "tfe.leak-host.example/leak-org/vault", version: "~> 3.0" },
        local: { source: "./leak-provider" },
      },
    },
  }),
);
fs.writeFileSync(
  path.join(outdir, "manifest.json"),
  JSON.stringify({
    version: "0.0.0-e2e",
    stacks: {
      [name]: {
        name,
        constructPath: name,
        workingDirectory: `stacks/${name}`,
        synthesizedStackPath: `stacks/${name}/cdk.tf.json`,
        stackMetadataPath: `stacks/${name}/metadata.json`,
        annotations: [],
        dependencies: [],
      },
    },
  }),
);
JS

echo "==> STACK trigger: cdktn synth (hand-written stack)"
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
CRASH_OUTPUT="$(node "$CDKTN" output --skip-synth 2>&1 || true)"

popd >/dev/null
rm -rf "$CRASH_WORK"

await_items 'cli.command.invoked' 'cli.command.error' '"cli.stack.provider"' '{"type":"event"}'
RAW="$(curl -sf "http://localhost:${PORT}/__raw")"
echo "==> sink recorded: $ITEMS"

fail() { echo "FAIL: $1" >&2; exit 1; }

echo "$ITEMS" | grep -q '"trace_metric"' \
  || fail "no trace_metric envelope reached the sink — the success-path flush is missing/broken"
echo "$ITEMS" | grep -q 'cli.command.invoked' \
  || fail "cli.command.invoked metric missing"
echo "$ITEMS" | grep -q '"binary"' \
  || fail "binary attribute missing on the command metrics"
echo "$ITEMS" | grep -q 'cli.command.error' \
  || fail "cli.command.error metric missing (error trigger)"
echo "$ITEMS" | grep -q '"cli.stack"' \
  || fail "cli.stack metric missing (stack trigger)"
echo "$ITEMS" | grep -q '"cli.stack.provider"' \
  || fail "cli.stack.provider metric missing (stack trigger)"
echo "$ITEMS" | grep -q '"cli.stack.override"' \
  || fail "cli.stack.override metric missing (stack trigger)"
for key in binding library_version override_count import_count resource_type; do
  echo "$ITEMS" | grep -q "\"$key\"" \
    || fail "$key attribute missing on the stack metrics"
done
echo "$RAW" | grep -q 'hashicorp/random' \
  || fail "normalized provider source missing from the stack metrics"
echo "$RAW" | grep -q 'private-registry' \
  || fail "private-registry provider was not reduced to its kind"
# matched as key/value adjacency inside the metric item, so a "production"
# elsewhere in the envelope cannot satisfy the check
echo "$RAW" | grep -q '"sentry.environment":{"value":"production"' \
  || fail "sentry.environment is not the fixed production value"
for secret in E2E-SECRET-STACK-NAME e2e-secret-resource-id leak-host.example leak-org leak-provider LEAK-ENV-SENTRY LEAK-BAGGAGE-SENTRY 0af7651916cd43dd8448eb211c80319c; do
  if echo "$RAW" | grep -q "$secret"; then
    fail "$secret reached the sink: stack names, resource ids, provider hosts/paths and SENTRY_* env values must never be sent"
  fi
done
echo "$ITEMS" | grep -q '"error_type"' \
  || fail "error_type attribute missing on cli.command.error"
echo "$RAW" | grep -q '"unexpected"' \
  || fail "the crash trigger was not counted as an unexpected cli.command.error"
echo "$ITEMS" | grep -q '{"type":"event"}' \
  || fail "no crash event reached the sink from the entrypoint failure path"
echo "$CRASH_OUTPUT" | grep -q '^Debug Information:' \
  || fail "the crash trigger did not reach the debug information block"
if echo "$CRASH_OUTPUT" | grep -q 'ERR_UNHANDLED_REJECTION\|PromiseRejectionHandledWarning'; then
  fail "the crash trigger orphaned a rejection"
fi

# A cheap bundle scan; the sink assertions above are what prove the transport.
HASHICORP_REFS="$(grep -c "checkpoint-api.hashicorp.com" "$CDKTN" || true)"
[ "$HASHICORP_REFS" = "0" ] || fail "bundle still references checkpoint-api.hashicorp.com ($HASHICORP_REFS hits)"

echo "PASS: success-path, error-path, per-stack and entrypoint-failure telemetry delivered to the local sink"
