# Implementation Plan: CDKTN Package Rename (Release 1)

**Branch**: `001-cdktn-package-rename` | **Date**: 2026-01-14 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-cdktn-package-rename/spec.md`

## Summary

Rename all public-facing package names, modules, and CLI commands from `cdktf` to `cdktn` for the cdk-terrain community fork while preserving internal symbols and logical IDs for backward compatibility. This enables the community fork to establish its own identity while allowing existing users to migrate without infrastructure state drift.

**Technical Approach**: Systematic find-and-replace across package manifests (package.json), JSII configurations, CLI entry points, templates, and user-facing strings while carefully preserving internal runtime symbols (`Symbol.for("cdktf/*")`) and synthesized logical IDs (`__cdktf_*`).

## Technical Context

**Language/Version**: TypeScript 5.4.5 (strict mode, target ES2018, CommonJS)
**Primary Dependencies**:

- Build: jsii 5.8.9, jsii-pacmak 1.112.0, esbuild 0.25.4
- Runtime: constructs (JSII base), yargs (CLI), ink (React UI), chalk
- Telemetry: @sentry/node 7.120.3
  **Storage**: N/A (no database; file-based config via `cdktf.json`)
  **Testing**: Jest 29.7.0 with ts-jest preset, 36+ test files in core, 28 in hcl2cdk
  **Target Platform**: Node.js 20+ (Linux, macOS, Windows); JSII targets: Python 3.x, Java, .NET, Go
  **Project Type**: Lerna monorepo with yarn workspaces
  **Performance Goals**: Same performance envelope as existing cdktf CLI (no measurable regression)
  **Constraints**:
- Internal symbols (`Symbol.for("cdktf/*")`) MUST remain unchanged
- Synthesized logical IDs (`__cdktf_*`) MUST remain unchanged
- `cdktf.json` and `CDKTF_*` env vars MUST continue working
  **Scale/Scope**: 8 packages to rename, ~10k LOC affected, 5 language targets (TS, Python, Java, C#, Go)

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

Verify compliance with principles from `.specify/memory/constitution.md`:

- [x] **Specification-First**: Spec.md complete with 5 prioritized user stories (P1-P3)
- [x] **Test-First**: Test strategy defined (existing Jest tests + integration tests for migration scenarios)
- [x] **Code Quality**: ESLint 9.x + Prettier 3.x already configured in repository
- [x] **UX Consistency**: User flows documented in spec.md acceptance scenarios (init, synth, migrate, convert)
- [x] **Performance**: Metrics defined - same performance envelope as cdktf CLI (SC-004)
- [x] **Observability**: Sentry telemetry strategy documented (FR-033, FR-034); re-use existing patterns
- [ ] **Issue Tracking**: Beads epic to be created after plan approval

**Complexity Violations** (if any, justify in Complexity Tracking table below):

- None identified - this is a systematic rename, not new feature development

### YAGNI/KISS Alignment

Per user instruction: **"We must understand existing code carefully and avoid introducing new dependencies"**

This plan adheres to:

- **YAGNI**: No new abstractions; rename only what exists
- **KISS**: Find-and-replace approach; no architectural changes
- **Minimal Viable Change**: Rename packages without bundling unrelated improvements
- **No New Dependencies**: Re-use existing build tools (jsii, esbuild), testing (jest), telemetry (sentry)

## Project Structure

### Documentation (this feature)

```text
specs/001-cdktn-package-rename/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (package mapping)
├── quickstart.md        # Phase 1 output (migration guide)
├── contracts/           # Phase 1 output (N/A - no new APIs)
└── tasks.md             # Phase 2 output (/specledger.tasks command)
```

### Source Code (repository root)

```text
packages/
├── cdktf/                     # → cdktn (core library, JSII)
│   ├── lib/                   # Core constructs (symbols preserved)
│   ├── package.json           # Name, JSII targets to update
│   └── dist/                  # Generated: Python, Java, .NET, Go
├── cdktf-cli/                 # → cdktn-cli (CLI entry point)
│   ├── src/bin/cdktf.ts       # → cdktn.ts (entry point)
│   ├── bundle/bin/cdktf       # → cdktn (built binary)
│   └── package.json           # Name, bin entry to update
├── @cdktf/cli-core/           # → @cdktn/cli-core
│   ├── src/lib/               # CLI implementation
│   └── templates/             # Project templates to update
├── @cdktf/commons/            # → @cdktn/commons
├── @cdktf/hcl-tools/          # → @cdktn/hcl-tools
├── @cdktf/hcl2cdk/            # → @cdktn/hcl2cdk
├── @cdktf/hcl2json/           # → @cdktn/hcl2json
├── @cdktf/provider-generator/ # → @cdktn/provider-generator
└── @cdktf/provider-schema/    # → @cdktn/provider-schema

test/                          # Integration tests (update references)
examples/                      # Example projects (update imports)
```

**Structure Decision**: Existing Lerna monorepo structure preserved; only package names and internal references change.

## Complexity Tracking

No violations - this feature follows all constitution principles:

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --------- | ---------- | ------------------------------------ |
| None      | N/A        | N/A                                  |

## Pre-Task Generation Spike: Completed

**Status**: ✅ **COMPLETED** - No blocking issues found

Dual-dependency coexistence spike conducted per clarification session. See [research.md](./research.md) for full findings.

### Spike Summary

| Area                      | Finding                                                                              | Risk |
| ------------------------- | ------------------------------------------------------------------------------------ | ---- |
| **Symbol.for() Behavior** | Global registry returns same symbol for both packages - enables transitional support | None |
| **Bundler Behavior**      | Both packages bundled; temporary size increase; tree-shaking works                   | Low  |
| **JSII Cross-Language**   | FQNs completely separate types (Python, Java, C#, Go)                                | None |
| **TypeScript Types**      | Aliased imports resolve; `skipLibCheck` as fallback                                  | Low  |
| **Peer Dependencies**     | Package managers handle mixed deps with warnings                                     | Low  |

### Key Findings

1. **Symbol.for() is a FEATURE**: Both packages using `Symbol.for("cdktf/TerraformResource")` returns the SAME global symbol. This enables `cdktf`'s type checks to pass for `cdktn` objects during migration (FR-025).

2. **No JSII Conflicts**: Language-specific FQNs (`cdktf.TerraformStack` vs `cdktn.TerraformStack`) keep types completely separate across Python, Java, C#, Go.

3. **Bundler Impact**: Temporary ~2x bundle size if both packages fully used. Mitigated by tree-shaking and completing migration promptly.

### Recommendations from Spike

1. Add optional runtime warning when both packages detected
2. Document bundle size implications in quickstart.md
3. Recommend completing migration promptly

**Outcome**: ✅ **PROCEED WITH IMPLEMENTATION** - No critical risk items identified

## Implementation Phases (High-Level)

### Phase 1: Core Package Renames

- Update package.json names and JSII configurations
- Update internal import paths
- Preserve runtime symbols (`Symbol.for("cdktf/*")`)

### Phase 2: CLI Rename

- Rename CLI entry point and binary
- Update user-facing text (help, logs, errors)
- Update templates to reference `cdktn` packages

### Phase 3: Provider Generator

- Ensure generated code references `cdktn` packages
- No `@cdktf/*` scope in generated manifests

### Phase 4: Migration Tooling

- Add `cdktn migrate` command
- Support import/dependency updates across published languages (TypeScript, Python, Go)
- Dry-run mode for safe preview (default: prints list of files and changes)
- Telemetry integration:
  - Update Sentry release tag to `cdktn-cli-${DISPLAY_VERSION}`
  - Add migration-specific event tracking (success, failure, dual-dependency detection)

### Phase 5: Validation

- Run relevant test suites (identify critical test suites for validation)
- Integration tests for all published languages (TypeScript, Python, Go)
- End-to-end: init → synth → get → convert
- CLI coexistence test: verify `cdktn` works correctly when `cdktf-cli` is also installed globally
