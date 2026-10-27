# Function availability matrix

`functions-matrix.json` records, for every built-in Terraform and OpenTofu
function, the stable releases in which it is available (introduced / removed /
gaps per product). It is consumed by:

- `../scripts/generate.ts` — merges OpenTofu-only functions into the `Fn`
  bindings.
- `../scripts/generate-function-availability.ts` — emits
  `packages/cdktn/src/functions/function-availability.generated.ts`, the
  version-constraint map used by the synth-time function version validation
  (`ValidateFunctionVersionSupport`).

## Regenerating

Only the matrix JSON is vendored in this repo. The baseline data sweep that
produces it — the per-release `metadata functions -json` dumps plus the
`build-matrix.py` / `build-report.py` / `sweep.sh` scripts and the interactive
HTML report — lives in the planning repo:

> **open-constructs/cdktn-planning** — `RFCS/03-function-availability/`

To pick up newly released Terraform/OpenTofu versions without a full sweep, run
the incremental updater (downloads only unseen releases into a temp dir):

```sh
pnpm --filter generate-function-bindings run update-function-matrix
pnpm --filter generate-function-bindings run generate-function-availability
```

The incremental updater only moves forward: it adds releases newer than the
latest one already in the matrix. Backported patch releases of older minors
(e.g. OpenTofu 1.11.x patches released alongside 1.12/1.13) are not picked up. To
ingest those, copy the planning repo's
`RFCS/03-function-availability/functions-matrix.json` over
`function-availability/functions-matrix.json` and re-run
`generate-function-availability` (and `generate`). Running
`update-function-matrix` afterwards should report the matrix as up to date.

A full regeneration from scratch is done with the sweep tooling in the planning
repo.
