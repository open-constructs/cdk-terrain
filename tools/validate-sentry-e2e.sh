#!/usr/bin/env bash
# Copyright (c) HashiCorp, Inc
# SPDX-License-Identifier: MPL-2.0
#
# End-to-end validation of the cdktn-cli Sentry telemetry pipeline against
# the REAL esbuild bundle (specledger/002-remove-hashicorp-telemetry,
# quickstart Journey 6):
#   1. rebuilds the bundle with a local-sink DSN baked in (esbuild define)
#   2. starts tools/sentry-sink.mjs
#   3. SUCCESS trigger: `cdktn convert` (dependency-free) — proves the
#      bounded success-path flush delivers a trace_metric envelope
#   4. ERROR trigger: `cdktn synth --app "node -e process.exit(1)"` —
#      proves the error path (event + cli.command.error metric)
#   5. asserts zero checkpoint-api.hashicorp.com references in the bundle
#
# NOTE: leaves the bundle built with the local DSN — rebuild before
# distributing (`pnpm nx run cdktn-cli:build` with the real SENTRY_DSN).
set -euo pipefail

PORT="${1:-9999}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSN="http://cdktn@localhost:${PORT}/1"
CDKTN="$ROOT/packages/cdktn-cli/bundle/bin/cdktn.js"

echo "==> building bundle with DSN $DSN baked in"
(cd "$ROOT/packages/cdktn-cli" && pnpm run compile-build-config >/dev/null && SENTRY_DSN="$DSN" node build-config/build.js)

echo "==> starting sentry sink on :$PORT"
node "$ROOT/tools/sentry-sink.mjs" "$PORT" &
SINK_PID=$!
trap 'kill $SINK_PID 2>/dev/null || true' EXIT
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

ITEMS="$(curl -sf "http://localhost:${PORT}/__items")"
echo "==> sink recorded: $ITEMS"

fail() { echo "FAIL: $1" >&2; exit 1; }

echo "$ITEMS" | grep -q '"trace_metric"' \
  || fail "no trace_metric envelope reached the sink — the success-path flush is missing/broken"
echo "$ITEMS" | grep -q 'cli.command.invoked' \
  || fail "cli.command.invoked metric missing"
echo "$ITEMS" | grep -q 'cli.command.error' \
  || fail "cli.command.error metric missing (error trigger)"
# The failing-app synth path hard-exits without throwing (graceful=false),
# so no crash EVENT is expected from these triggers; crash-event delivery
# is covered by the unit suite (beforeSend pass-through + Sentry.close on
# the yargs fail path).

HASHICORP_REFS="$(grep -c "checkpoint-api.hashicorp.com" "$CDKTN" || true)"
[ "$HASHICORP_REFS" = "0" ] || fail "bundle still references checkpoint-api.hashicorp.com ($HASHICORP_REFS hits)"

echo "PASS: success-path and error-path usage metrics delivered to the local sink; zero HashiCorp references in the bundle"
echo "NOTE: bundle now contains the local-sink DSN — rebuild before distributing."
