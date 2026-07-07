# Provider feature availability matrix

`features-matrix.json` records, for every provider plugin-protocol capability
family surfaced by `providers schema -json` (provider-defined functions,
ephemeral resources, write-only attributes, resource identity, list resources,
actions, state stores), the Terraform and OpenTofu releases whose CLI emits it
— merged from sweep observations and source-verified CLI serializer history.

It is the source dataset for the hand-maintained
`packages/cdktn/src/provider-feature-constraints.ts` map used by the
synth-time `ValidateFeatureTargetSupport` check against a project's declared
`targetVersions`.

Note the provider-functions asymmetry: OpenTofu supports the
`provider::ns::fn()` language syntax from 1.7.0, but its
`providers schema -json` only emits the `functions` key from 1.8.0 — usage
validation uses the language boundary, schema acquisition the emission
boundary.

## In-repo consumers

Two hand-maintained maps are derived from this matrix and must be kept in
sync with it by hand:

- `packages/cdktn/src/provider-feature-constraints.ts` —
  `providerFeatureConstraints`, the _usage_ boundaries (language support) per
  feature family, keyed off each feature's `documented_ga`/language-support
  version here. This is where the deliberate OpenTofu `providerFunctions`
  exception lives: 1.7.0 (language support) rather than 1.8.0 (schema
  emission).
- `packages/@cdktn/provider-schema/src/emission-check.ts` —
  `SCHEMA_EMISSION_BOUNDARIES`, the _schema-emission_ boundaries (when
  `providers schema -json` starts including the family's key) per feature
  family, keyed off each feature's `documented_emitted_from` /
  `observed_introduced` fields here.

There is no automated check today that these two maps agree with
`features-matrix.json` — updates must be applied by hand when the matrix
changes. An automated drift check is tracked in #309.

## Regenerating

Only the matrix JSON is vendored in this repo. The baseline data sweep that
produces it — the per-release `providers schema -json` digests plus the
`build-matrix.py` / `build-report.py` / `sweep.sh` scripts, the pinned
fixtures, the interactive HTML report, and the design proposal — lives in the
planning repo:

> **open-constructs/cdktn-planning** — `RFCS/04-provider-feature-availability/`

New CLI minors are appended by re-running `scripts/sweep.sh` there (idempotent;
existing digests are skipped) followed by `build-matrix.py`, which fails loudly
if a new observation contradicts the documented serializer history.
