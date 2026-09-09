#!/usr/bin/env bash
# Copyright (c) HashiCorp, Inc
# SPDX-License-Identifier: MPL-2.0
#
# End-to-end validation of the cdktn-cli Sentry telemetry pipeline against
# the real esbuild bundle:
#   1. rebuilds the bundle with a local-sink DSN baked in (esbuild define)
#   2. starts tools/sentry-sink.mjs
#   3. SUCCESS trigger: `cdktn convert` (dependency-free) — proves the
#      bounded success-path flush delivers a trace_metric envelope
#   4. ERROR trigger: `cdktn synth --app "node -e process.exit(1)"` —
#      proves the error path (event + cli.command.error metric)
#   5. STACK trigger: `cdktn synth --app "node fake-app.js"` where the app
#      writes a manifest and one cdk.tf.json by hand (no cdktn library
#      needed) — proves the per-stack cli.stack* metrics and that the
#      stack name never reaches the wire
#   6. asserts zero checkpoint-api.hashicorp.com references in the bundle
#   7. on exit, rebuilds the bundle with the caller's SENTRY_DSN so the
#      artifact never ships pointing at the local sink
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
for secret in E2E-SECRET-STACK-NAME e2e-secret-resource-id leak-host.example leak-org leak-provider; do
  echo "$RAW" | grep -q "$secret" \
    && fail "$secret reached the sink: stack names, resource ids and provider hosts/paths must never be sent"
done
# The failing-app synth path hard-exits without throwing (graceful=false),
# so no crash EVENT is expected from these triggers; crash-event delivery
# is covered by the unit suite (beforeSend pass-through + Sentry.close on
# the yargs fail path).

HASHICORP_REFS="$(grep -c "checkpoint-api.hashicorp.com" "$CDKTN" || true)"
[ "$HASHICORP_REFS" = "0" ] || fail "bundle still references checkpoint-api.hashicorp.com ($HASHICORP_REFS hits)"

echo "PASS: success-path, error-path and per-stack usage metrics delivered to the local sink; zero HashiCorp references in the bundle"
