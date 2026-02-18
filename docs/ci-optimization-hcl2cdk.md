# CI Optimization: Reduce hcl2cdk Test Runtime & Scoped Builds

## Summary

Three changes that together save ~16 min of aggregate CI compute per run:

1. **Scoped builds** — Replace full monorepo `yarn build` with per-package `lerna run --scope` builds, saving ~35s per job across 14 non-hcl2cdk jobs.
2. **Parallel test execution** — Remove `--runInBand` from hcl2cdk tests. A new Jest `globalSetup` pre-generates all provider bindings and base projects once, eliminating the per-worker race conditions that originally forced serialization.
3. **Provider schema pre-caching** — The `globalSetup` also pre-caches all 12 provider schemas using `CDKTF_EXPERIMENTAL_PROVIDER_SCHEMA_CACHE_PATH`, so test workers never shell out to `terraform init` / `terraform providers schema`. This eliminates the Terraform plugin cache collisions that caused test failures under parallelism.

**Result**: hcl2cdk test step drops from ~11m27s (serial) to ~7 min (parallel), with 0 Terraform-related flaky failures.

## Problem

The `unit_test (@cdktn/hcl2cdk)` CI job took ~14m54s per run, with the test step alone at ~11m27s (77% of job time). Two main issues:

1. **Every unit test job compiled the full monorepo** (~63s each, 16 jobs = ~15 min aggregate waste)
2. **hcl2cdk tests ran single-threaded** (`--runInBand`) on a 16-core depot runner

### Why `--runInBand` existed

In September 2023, parallel test workers were each independently running `cdktf get` and `cdktf init`, causing Terraform plugin cache collisions and filesystem race conditions. After several attempts to fix the parallelism (`41a2e7f`, `f2e06fd`), the workaround was to serialize all tests with `--runInBand` (`5ba985c`).

## Changes

### 1. Jest `globalSetup` / `globalTeardown` (new files)

**`packages/@cdktn/hcl2cdk/test/globalSetup.ts`**

Runs once before any test worker starts:

- Generates all 12 provider bindings via `cdktn get` (in parallel)
- Initializes base projects for required languages via `cdktn init` (in parallel)
- Pre-caches provider schemas via `readSchema()` (sequentially, one provider at a time) into a schema cache directory, using the `CDKTF_EXPERIMENTAL_PROVIDER_SCHEMA_CACHE_PATH` mechanism — this eliminates all `terraform init` / `terraform providers schema` calls from test workers
- Writes a JSON manifest mapping provider FQNs, languages, and schema cache path to their generated paths
- Sets env vars (`HCL2CDK_FIXTURES_MANIFEST`, `CDKTF_EXPERIMENTAL_PROVIDER_SCHEMA_CACHE_PATH`) for workers

**`packages/@cdktn/hcl2cdk/test/globalTeardown.ts`**

Runs once after all workers finish:

- Cleans up the temp fixtures directory

### 2. Refactored test helper to use pre-generated fixtures

**`packages/@cdktn/hcl2cdk/test/helpers/convert.ts`**

- Removed module-level `prepareBaseProject()` calls and `generateBindings()` / `providerBindingCache` — these ran expensive `cdktn init`/`cdktn get` per-worker
- Added `getManifest()` that lazily reads the fixtures manifest from the env var
- `copyBindingsForProvider()` now copies from pre-generated paths in the manifest
- `getProjectDirectory()` now reads base project paths from the manifest instead of awaiting per-worker promises
- `getProviderSchema()` now uses the schema cache (via env var or manifest), so `readSchema()` gets cache hits and never shells out to Terraform

### 3. Enabled file-level parallelism

**`packages/@cdktn/hcl2cdk/package.json`**

Removed `--runInBand` from `test`, `test:ci`, and `test:update` scripts. This is now safe because:

- Provider bindings, base projects, and schemas are generated once in `globalSetup` (no more cache collisions)
- Workers never run `terraform init` or `terraform providers schema` — all schema reads are cache hits
- `process.chdir()` is isolated per Jest worker process
- 19 test files can run across multiple cores simultaneously

**`packages/@cdktn/hcl2cdk/jest.config.js`**

Added `globalSetup` and `globalTeardown` entries pointing to the new files.

### 4. Scoped compile step in CI

**`.github/workflows/unit.yml`**

Replaced the full monorepo build:

```yaml
# Before
- name: compile
  run: |
    tools/align-version.sh
    yarn build
    yarn package
```

With a scoped build per package, plus a conditional step for hcl2cdk:

```yaml
# After
- name: compile
  run: |
    tools/align-version.sh
    npx lerna run --scope '${{ inputs.package }}' build

- name: compile cdktn-cli and package
  if: inputs.package == '@cdktn/hcl2cdk'
  run: |
    npx lerna run --scope 'cdktn-cli' build
    yarn package
```

Nx integration (`build.dependsOn: ["^build"]`) automatically resolves and builds transitive dependencies. The `@cdktn/hcl2cdk` tests additionally need the `cdktn-cli` binary and `dist/` packages.

## Local Verification

- Full build + package: ~61s
- hcl2cdk tests (parallelized): **~7 min wall clock** (includes globalSetup schema caching)
- 27/28 suites passed (1 skipped), 279/280 tests passed (1 skipped), 202 snapshots matched
- 0 Terraform cache collision failures (previously 15 failures without schema pre-caching)
- `globalSetup` and `globalTeardown` ran and cleaned up successfully

## Efficiency Gains

### Before (baseline)

| Metric                    | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| hcl2cdk CI job wall clock | ~14m54s                                                             |
| hcl2cdk test step alone   | ~11m27s (single-threaded `--runInBand`)                             |
| Compile step per CI job   | full monorepo `yarn build` (~63s each, 16 jobs = ~15 min aggregate) |

### After

| Metric                                  | Value                                                               |
| --------------------------------------- | ------------------------------------------------------------------- |
| hcl2cdk test step (local, parallelized) | ~7 min wall clock (was ~11m27s)                                     |
| Terraform calls during tests            | 0 (all cached in globalSetup)                                       |
| Compile step per CI job                 | scoped `lerna run --scope` build (~35s savings per non-hcl2cdk job) |

### Estimated CI Impact

| Optimization                              | Estimated Savings                                  |
| ----------------------------------------- | -------------------------------------------------- |
| Scoped builds (non-hcl2cdk jobs)          | ~35s avg x 14 jobs = **~8 min aggregate**          |
| hcl2cdk test parallelism + schema caching | ~4 min per job x 2 terraform versions = **~8 min** |
| **Total**                                 | **~16 min aggregate compute saved per CI run**     |
