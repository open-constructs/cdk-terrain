# Plan: Affected-Only Unit Tests in CI

## Context

Every PR currently runs **16 unit test jobs** (8 packages × 2 Terraform versions) regardless of what changed. A PR that only touches `CHANGELOG.md` or `.github/` still triggers all 250+ tests. This wastes CI minutes and slows down reviews.

The repo already has **Nx 20.8.2** installed with a project graph that correctly resolves workspace dependencies. `nx show projects --affected` works out of the box — verified locally that it correctly identifies `@cdktn/cli-core` + `cdktn-cli` + downstream examples when only `cli-core` was changed, and returns empty for non-package file changes.

## Approach: Nx `affected` with dynamic matrix

Use `nx show projects --affected` in a pre-job to build a dynamic matrix for `pr-unit.yml`. No new dependencies needed.

**Why Nx over alternatives:**

- Already installed and working (v20.8.2)
- Walks the dependency graph transitively (Lerna `--since` does not)
- No migration needed (Turborepo would require replacing Lerna)

## Files to Modify

1. **`.github/workflows/pr-unit.yml`** — add `determine-affected` job, make `all_unit_tests` matrix dynamic
2. **`tools/affected-packages.sh`** (new) — shell script to compute affected testable packages with fallback

## Implementation

### Step 1: Create `tools/affected-packages.sh`

Script that:

- Runs `npx nx show projects --affected --base=$BASE_REF --head=HEAD`
- Filters output to only the 8 testable packages (excludes examples, hcl-tools, etc.)
- Outputs a JSON array for GitHub Actions matrix consumption
- **Fallback**: if Nx fails or errors, outputs all 8 packages (safe default)
- **Empty case**: if no packages affected, outputs `[]`

### Step 2: Modify `pr-unit.yml`

Add a new `determine-affected` job before `all_unit_tests`:

```
determine-affected (ubuntu-latest, ~30s)
  ├─ checkout with fetch-depth: 0
  ├─ setup node + yarn install
  ├─ if label 'ci/run-all-unit' → output all 8 packages
  ├─ else → run tools/affected-packages.sh with PR base SHA
  └─ outputs: packages (JSON array), has_packages (bool)
```

Modify `all_unit_tests`:

- Add `needs: determine-affected`
- Add condition: `has_packages == 'true'`
- Replace hardcoded `package` matrix with `fromJSON(needs.determine-affected.outputs.packages)`
- Keep `terraform_version: ["1.6.5", "1.5.5"]` hardcoded

Handle `merge_group` vs `pull_request`:

- PR: `base_sha = github.event.pull_request.base.sha`
- merge_group: `base_sha = github.event.merge_group.base_sha`

Add `determine-affected` to the `results` job `needs` list.

### Step 3: Add `ci/run-all-unit` label override

In the `determine-affected` job, check for label and short-circuit to all packages. This preserves manual control for cases where you want to force full test coverage.

## What stays unchanged

- **`unit.yml`** (reusable workflow) — no changes
- **All per-package label-based jobs** (`cdktn`, `cdktn_cli`, etc.) — kept as-is
- **Integration/provider/example workflows** — out of scope for this change (can add path filtering later)
- **Build caching, concurrency groups** — unchanged

## Expected Impact

| PR touches                      | Jobs before | Jobs after               |
| ------------------------------- | ----------- | ------------------------ |
| Only docs/CI/changelog          | 16          | 0                        |
| Single leaf (`cdktn-cli`)       | 16          | 2 (1 pkg × 2 TF)         |
| `@cdktn/hcl2json`               | 16          | 10 (5 pkgs × 2 TF)       |
| Core `cdktn` lib                | 16          | 16 (all affected)        |
| Root `package.json`/`yarn.lock` | 16          | 16 (Nx treats as global) |

## Verification

1. Run `bash tools/affected-packages.sh origin/main` locally on various branches to verify output
2. Open a docs-only PR → confirm 0 unit test jobs run
3. Open a PR touching `@cdktn/commons` → confirm only `commons` + dependents are tested
4. Apply `ci/run-all-unit` label → confirm all 16 jobs run
5. Verify `results` job still correctly reports pass/fail
