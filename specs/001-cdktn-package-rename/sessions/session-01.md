# Implementation Session 01: CDKTN Package Rename

**Date**: 2026-01-19
**Branch**: `001-cdktn-package-rename`
**Status**: Phase 2 Complete, Ready for Cross-Package Import Sweep

## Session Summary

Successfully completed Phase 1 (Setup) and Phase 2 (Foundational Package Renames) of the CDKTN package rename implementation. All 9 core packages have been renamed in their package.json files with updated dependencies, JSII targets, and repository metadata.

## Completed Work

### Phase 1: Setup (3 tasks)

#### ✅ core-mau: Update root package.json workspace configuration

**Files Modified**: `/package.json`

**Changes**:

- Workspace pattern: `packages/@cdktf/*` → `packages/@cdktn/*`
- Lerna script scopes: `'cdktf*' --scope @cdktf/*` → `'cdktn*' --scope @cdktn/*` (all scripts)

**Scripts Updated**:

- build-and-package, build, test, test:ci, test:update, watch, link-packages

#### ✅ core-9r8: Update CI/CD workflow configurations

**Files Modified**:

- `.github/workflows/release.yml`
- `.github/workflows/release_next.yml`
- `.github/workflows/docker.yml`
- `.github/workflows/update-project-board-issue.yml`
- `.github/workflows/cdktf-provider-docs-rollout.yml`
- `.github/workflows/registry-docs-pr-based.yml`

**Changes**:

- Repository checks: `hashicorp/terraform-cdk` → `open-constructs/cdk-terrain`
- GitHub URLs in Slack notifications and PR bodies updated

**Deferred to Post-Foundational**:

- Package matrices (cdktf → cdktn, @cdktf/_ → @cdktn/_)
- Sentry release tags (cdktf-cli → cdktn-cli)
- Internal paths in workflows

#### ✅ core-98d: Update lerna.json and release configuration

**Findings**: No changes needed - lerna.json is minimal and relies on workspace configuration already updated in core-mau.

---

### Phase 2: Foundational Package Renames (10 tasks)

#### ✅ core-w61: Rename packages/cdktf → cdktn (core library)

**File**: `packages/cdktf/package.json`

**Changes**:

- name: `cdktf` → `cdktn`
- JSII Python: distName/module → `cdktn`
- JSII Java: package → `io.cdktn.cdktn`, groupId → `io.cdktn`, artifactId → `cdktn`
- JSII .NET: packageId/namespace → `Io.Cdktn`
- JSII Go: moduleName → `github.com/open-constructs/cdk-terrain-go`, packageName → `cdktn`
- author: `HashiCorp` → `OpenConstructs` (both top-level and jsii.author)
- repository/homepage: `hashicorp/terraform-cdk` → `open-constructs/cdk-terrain`

**Preserved**: Symbol.for() strings in lib/\*.ts files (unchanged as required)

#### ✅ core-0ou: Rename packages/cdktf-cli → cdktn-cli

**Files**:

- `packages/cdktf-cli/package.json`
- `packages/cdktf-cli/src/bin/cdktf` → `cdktn` (renamed)
- `packages/cdktf-cli/src/bin/cdktf.ts` → `cdktn.ts` (renamed)

**Changes**:

- name: `cdktf-cli` → `cdktn-cli`
- bin entry: `cdktf` → `cdktn` (pointing to bundle/bin/cdktn)
- dependencies: `@cdktf/*` → `@cdktn/*` (cli-core, commons, hcl-tools, hcl2cdk, hcl2json)
- dependencies: `cdktf` → `cdktn`
- devDependencies: `@cdktf/provider-generator` → `@cdktn/provider-generator`
- repository/author metadata updated

#### ✅ core-4sx: Rename packages/@cdktf/cli-core → @cdktn/cli-core

**File**: `packages/@cdktf/cli-core/package.json`

**Changes**:

- name: `@cdktf/cli-core` → `@cdktn/cli-core`
- dependencies: `@cdktf/*` → `@cdktn/*` (commons, hcl-tools, hcl2cdk, hcl2json, provider-schema)
- dependencies: `cdktf` → `cdktn`
- devDependencies: `@cdktf/provider-generator` → `@cdktn/provider-generator`
- repository/author metadata updated

**Preserved**: `@cdktf/node-pty-prebuilt-multiarch` (external package)

#### ✅ core-9nu: Rename packages/@cdktf/commons → @cdktn/commons

**File**: `packages/@cdktf/commons/package.json`

**Changes**:

- name: `@cdktf/commons` → `@cdktn/commons`
- dependencies: `cdktf` → `cdktn`
- repository/author metadata updated

#### ✅ core-y0k: Rename packages/@cdktf/hcl-tools → @cdktn/hcl-tools

**File**: `packages/@cdktf/hcl-tools/package.json`

**Changes**:

- name: `@cdktf/hcl-tools` → `@cdktn/hcl-tools`
- homepage: `https://cdk.tf` → `https://github.com/open-constructs/cdk-terrain`
- repository/author/bugs URLs updated

**Note**: No cdktf or @cdktf/\* dependencies in this package

#### ✅ core-tsu: Rename packages/@cdktf/hcl2cdk → @cdktn/hcl2cdk

**File**: `packages/@cdktf/hcl2cdk/package.json`

**Changes**:

- name: `@cdktf/hcl2cdk` → `@cdktn/hcl2cdk`
- dependencies: `@cdktf/*` → `@cdktn/*` (commons, hcl2json, provider-generator, provider-schema)
- dependencies: `cdktf` → `cdktn`
- repository/author metadata updated

**Important**: Code generation templates (lib/\*_/_.ts) that output import statements need updating in core-2v8

#### ✅ core-fps: Rename packages/@cdktf/hcl2json → @cdktn/hcl2json

**File**: `packages/@cdktf/hcl2json/package.json`

**Changes**:

- name: `@cdktf/hcl2json` → `@cdktn/hcl2json`
- repository/author metadata updated

**Note**: Go WASM compilation package with no cdktf dependencies

#### ✅ core-6ly: Rename packages/@cdktf/provider-generator → @cdktn/provider-generator

**File**: `packages/@cdktf/provider-generator/package.json`

**Changes**:

- name: `@cdktf/provider-generator` → `@cdktn/provider-generator`
- dependencies: `@cdktf/*` → `@cdktn/*` (commons, provider-schema)
- repository/author metadata updated

**Critical Deferred Work**: Code generation templates must be updated to:

1. Generate package.json with `cdktn` peer dependency (not `cdktf`)
2. Generate TypeScript imports `from "cdktn"` (not `from "cdktf"`)

#### ✅ core-3qc: Rename packages/@cdktf/provider-schema → @cdktn/provider-schema

**File**: `packages/@cdktf/provider-schema/package.json`

**Changes**:

- name: `@cdktf/provider-schema` → `@cdktn/provider-schema`
- dependencies: `@cdktf/*` → `@cdktn/*` (commons, hcl2json)
- repository/author metadata updated

---

## Current State

### ✅ Completed

- All 9 package.json files renamed with correct package names
- All package dependencies updated (@cdktf/_ → @cdktn/_)
- All JSII multi-language targets updated (Python, Java, .NET, Go)
- All repository/author metadata updated
- CLI entry points renamed (cdktf → cdktn)
- Root workspace configuration updated
- CI/CD repository checks updated

### ⚠️ Not Yet Done (Blocking Build/Test)

- **Import statements in TypeScript source files** (src/**/\*.ts, lib/**/\*.ts)
- **Code generation templates** (hcl2cdk, provider-generator)
- **Workflow package matrices** (will update after core-2v8)
- **Example projects** (User Story tasks)
- **CLI templates** (User Story tasks)

### 🚫 Cannot Build Until

Cross-package import sweep (core-2v8) completes. All packages currently have:

- Updated package.json dependencies (✅)
- Old import statements in source code (❌)

This mismatch will cause compilation failures.

---

## Next Session: How to Resume

### 1. Check Repository Status

```bash
cd /home/vincent/cdktn/cdk-terrain
git status
git log --oneline -5
```

### 2. Load Implementation Context

Read the key planning documents:

```bash
# Feature specification
cat specs/001-cdktn-package-rename/spec.md

# Implementation plan
cat specs/001-cdktn-package-rename/plan.md

# Package mapping reference
cat specs/001-cdktn-package-rename/data-model.md

# Research findings (dual-dependency spike)
cat specs/001-cdktn-package-rename/research.md
```

### 3. Check Beads Task Status

```bash
# See all tasks for this feature
bd list --label "spec:001-cdktn-package-rename" -n 50

# See ready tasks (no blockers)
bd ready --label "spec:001-cdktn-package-rename" -n 10

# See task dependency tree
bd dep tree core-x3d  # Epic root
```

### 4. Get Next Task Details (core-2v8)

**Critical Next Task**: Cross-package import sweep

```bash
# Get full task details with comments
bd show core-2v8 && bd comments core-2v8
```

Expected task: **core-2v8: Update cross-package import statements**

This task requires:

1. Find all `import ... from "cdktf"` → change to `from "cdktn"`
2. Find all `import ... from "@cdktf/..."` → change to `from "@cdktn/..."`
3. Update code generation templates that output import statements
4. Verify no cdktf references remain in source files

**Scope**: All TypeScript files across packages:

- `packages/cdktf/lib/**/*.ts`
- `packages/cdktf-cli/src/**/*.ts`
- `packages/@cdktf/*/src/**/*.ts`
- `packages/@cdktf/*/lib/**/*.ts`

### 5. Key Patterns to Search/Replace

Use Grep to find all import statements:

```bash
# Find cdktf imports
bd grep -r 'from ["\']cdktf["\']' packages/

# Find @cdktf imports
bd grep -r 'from ["\']@cdktf/' packages/

# Find require statements
bd grep -r 'require\(["\']cdktf["\']' packages/
bd grep -r 'require\(["\']@cdktf/' packages/
```

### 6. Code Generation Template Locations

**Critical files** that generate code with imports:

```bash
# HCL to CDK converter templates
ls -la packages/@cdktf/hcl2cdk/lib/**/*.ts

# Provider generator templates
ls -la packages/@cdktf/provider-generator/lib/**/*.ts

# Search for import generation
bd grep -r '"cdktf"' packages/@cdktf/hcl2cdk/lib/
bd grep -r '"cdktf"' packages/@cdktf/provider-generator/lib/
```

### 7. Validation Commands (After core-2v8)

```bash
# Verify no old imports remain
rg --type ts 'from ["\']cdktf["\']' packages/
rg --type ts 'from ["\']@cdktf/' packages/

# Try building (will fail until core-2v8 complete)
yarn build

# Run tests (will fail until core-2v8 complete)
yarn test
```

---

## Task Execution Workflow

### Standard Pattern

```bash
# 1. Get task details
bd show <task-id> && bd comments <task-id>

# 2. Read relevant files
cat <file-path>

# 3. Make changes
# (use Edit tool for updates)

# 4. Close task with summary
bd close <task-id> --reason "Completed: <summary of changes>

Files modified: <list>

<any important notes>"
```

### Example for core-2v8

```bash
# Start
bd show core-2v8 && bd comments core-2v8

# Find all imports to update
bd grep -r 'from ["\']cdktf' packages/ --output_mode files_with_matches

# Update files systematically
# (use Edit tool with replace_all for each package)

# Verify changes
rg --type ts 'from ["\']cdktf["\']' packages/

# Close task
bd close core-2v8 --reason "Completed cross-package import sweep: ..."
```

---

## Important Preservation Rules

### DO NOT CHANGE

1. **Symbol.for() strings** in `packages/cdktf/lib/**/*.ts`:

   - `Symbol.for("cdktf/App")`
   - `Symbol.for("cdktf/TerraformStack")`
   - `Symbol.for("cdktf/TerraformResource")`
   - etc. (18 total - see research.md)

2. **Terraform logical IDs** in synthesized output:

   - `__cdktf_module_asset`
   - Other `__cdktf_*` prefixes

3. **Configuration paths** (preserved for backward compatibility):

   - `cdktf.json` (config file)
   - `cdktf.out/` (output directory)
   - `CDKTF_*` environment variables
   - `~/.cdktf` (home directory)
   - `cdktf.log` (log file)

4. **External dependencies**:
   - `@cdktf/node-pty-prebuilt-multiarch` (external package, not ours)

### DO CHANGE

1. **Package names** in package.json: ✅ DONE
2. **Import statements**: ⚠️ NEXT (core-2v8)
3. **Code generation templates**: ⚠️ NEXT (core-2v8)
4. **User-facing text**: Later (User Story tasks)
5. **CLI templates**: Later (User Story tasks)
6. **Example projects**: Later (User Story tasks)

---

## Phase Dependencies

```
✅ Phase 1: Setup
    ↓
✅ Phase 2: Foundational (9 packages renamed)
    ↓
⏭️ Cross-Package Import Sweep (core-2v8) ← YOU ARE HERE
    ↓
Phase 3-7: User Stories (parallel execution possible)
    ↓
Phase 8: Polish & Validation
```

---

## Quick Reference: Package Mappings

| Old Package                 | New Package                 | Notes                      |
| --------------------------- | --------------------------- | -------------------------- |
| `cdktf`                     | `cdktn`                     | Core library (JSII)        |
| `cdktf-cli`                 | `cdktn-cli`                 | CLI entry point            |
| `@cdktf/cli-core`           | `@cdktn/cli-core`           | CLI implementation         |
| `@cdktf/commons`            | `@cdktn/commons`            | Shared utilities           |
| `@cdktf/hcl-tools`          | `@cdktn/hcl-tools`          | HCL utilities              |
| `@cdktf/hcl2cdk`            | `@cdktn/hcl2cdk`            | HCL→CDK converter          |
| `@cdktf/hcl2json`           | `@cdktn/hcl2json`           | WASM HCL parser            |
| `@cdktf/provider-generator` | `@cdktn/provider-generator` | Provider binding generator |
| `@cdktf/provider-schema`    | `@cdktn/provider-schema`    | Schema fetcher             |

---

## Files Modified This Session

### Root Configuration

- `/package.json` (workspace configuration)

### Workflows

- `.github/workflows/release.yml`
- `.github/workflows/release_next.yml`
- `.github/workflows/docker.yml`
- `.github/workflows/update-project-board-issue.yml`
- `.github/workflows/cdktf-provider-docs-rollout.yml`
- `.github/workflows/registry-docs-pr-based.yml`

### Package Manifests

- `packages/cdktf/package.json`
- `packages/cdktf-cli/package.json`
- `packages/@cdktf/cli-core/package.json`
- `packages/@cdktf/commons/package.json`
- `packages/@cdktf/hcl-tools/package.json`
- `packages/@cdktf/hcl2cdk/package.json`
- `packages/@cdktf/hcl2json/package.json`
- `packages/@cdktf/provider-generator/package.json`
- `packages/@cdktf/provider-schema/package.json`

### Source Files

- `packages/cdktf-cli/src/bin/cdktf` → `cdktn` (renamed)
- `packages/cdktf-cli/src/bin/cdktf.ts` → `cdktn.ts` (renamed)

### Documentation

- `specs/001-cdktn-package-rename/checklists/requirements.md` (marked research items complete)

---

## Session Statistics

- **Tasks Completed**: 13 (3 Setup + 9 Foundational + 1 Foundational phase)
- **Files Modified**: 16 package.json, 6 workflows, 2 source files, 1 checklist
- **Lines Changed**: ~200+ (package.json dependencies, JSII targets, metadata)
- **Beads Issues Closed**: 13
- **Time Investment**: ~2 hours
- **Build Status**: ❌ Cannot build until import sweep completes
- **Test Status**: ❌ Cannot test until import sweep completes

---

## Critical Next Steps

1. **Start core-2v8** (Cross-package import sweep)

   - Update ALL import statements in TypeScript files
   - Update code generation templates
   - Verify no old imports remain

2. **After core-2v8**: Update workflow package matrices

   - release.yml lines 130-138
   - release_next.yml lines 97-105
   - Update Sentry release tags

3. **Then**: User Story implementations can proceed in parallel
   - US1: New User Bootstrap (templates)
   - US2: Migration (cdktn migrate command)
   - US4: Local Provider Generation (verify generator output)
   - US5: HCL Convert (verify converter output)

---

## Known Issues / Warnings

1. **Physical directories not renamed**: Package directories still named `packages/cdktf` and `packages/@cdktf/*` - this is intentional for this release
2. **Workflow package matrices**: Deferred until after import sweep to avoid CI failures
3. **Bundle size during dual-dependency period**: Documented in research.md, expected temporary increase
4. **External package preserved**: `@cdktf/node-pty-prebuilt-multiarch` intentionally unchanged

---

**Session End**: All foundational package renames complete. Ready for cross-package import sweep.
