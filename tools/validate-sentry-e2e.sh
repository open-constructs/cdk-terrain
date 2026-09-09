#!/usr/bin/env bash
# Copyright (c) HashiCorp, Inc
# SPDX-License-Identifier: MPL-2.0
#
# End-to-end check of cdktn-cli telemetry on the real esbuild bundle: rebuilds
# it with a local-sink DSN, runs convert (success), a failing synth (error), a
# hand-written stack (per-stack metrics) and a crashing command (entrypoint
# failure path), then asserts on what reached tools/sentry-sink.mjs. On exit
# the bundle is rebuilt with the caller's DSN.
set -euo pipefail

PORT="${1:-9999}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSN="http://cdktn@localhost:${PORT}/1"
CDKTN="$ROOT/packages/cdktn-cli/bundle/bin/cdktn.js"
ORIGINAL_DSN="${SENTRY_DSN:-}"
SINK_PID=""

build_bundle() {
  (cd "$ROOT/packages/cdktn-cli" && pnpm run compile-build-config >/dev/null && SENTRY_DSN="$1" node build-config/build.js)
}

cleanup() {
  local status=$?
  [ -n "$SINK_PID" ] && kill "$SINK_PID" 2>/dev/null || true
  echo "==> restoring bundle with the caller's SENTRY_DSN"
  build_bundle "$ORIGINAL_DSN"
  exit "$status"
}
trap cleanup EXIT

echo "==> building bundle with DSN $DSN baked in"
build_bundle "$DSN"

echo "==> starting sentry sink on :$PORT"
node "$ROOT/tools/sentry-sink.mjs" "$PORT" &
SINK_PID=$!
sleep 0.3

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
node "$CDKTN" synth --check-code-maker-output=false >/dev/null

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

ITEMS="$(curl -sf "http://localhost:${PORT}/__items")"
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
echo "$ITEMS" | grep -q '"sentry.environment"' && echo "$RAW" | grep -q '"production"' \
  || fail "sentry.environment is not the fixed production value"
for secret in E2E-SECRET-STACK-NAME e2e-secret-resource-id leak-host.example leak-org leak-provider LEAK-ENV-SENTRY LEAK-BAGGAGE-SENTRY 0af7651916cd43dd8448eb211c80319c; do
  echo "$RAW" | grep -q "$secret" \
    && fail "$secret reached the sink: stack names, resource ids, provider hosts/paths and SENTRY_* env values must never be sent"
done
echo "$ITEMS" | grep -q '"error_type"' \
  || fail "error_type attribute missing on cli.command.error"
echo "$RAW" | grep -q '"unexpected"' \
  || fail "the crash trigger was not counted as an unexpected cli.command.error"
echo "$ITEMS" | grep -q '{"type":"event"}' \
  || fail "no crash event reached the sink from the entrypoint failure path"
echo "$CRASH_OUTPUT" | grep -q '^Debug Information:' \
  || fail "the crash trigger did not reach the debug information block"
echo "$CRASH_OUTPUT" | grep -q 'ERR_UNHANDLED_REJECTION\|PromiseRejectionHandledWarning' \
  && fail "the crash trigger orphaned a rejection"

HASHICORP_REFS="$(grep -c "checkpoint-api.hashicorp.com" "$CDKTN" || true)"
[ "$HASHICORP_REFS" = "0" ] || fail "bundle still references checkpoint-api.hashicorp.com ($HASHICORP_REFS hits)"

echo "PASS: success-path, error-path, per-stack and entrypoint-failure telemetry delivered to the local sink; zero HashiCorp references in the bundle"
