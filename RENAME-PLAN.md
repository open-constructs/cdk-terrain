# CDKTN Rename Plan (Release 1 Focus)

This plan is for Release 1 to deliver new package names and scopes while preserving internal symbols and logical IDs to minimize state churn. Future Releases to handle clean cut for internal symbols and logical IDs.

Constraints and decisions captured:

- We do not control existing `cdktf` registry entries, so no aliasing there.
- The old project is archived and out of our control; we cannot enforce old CLI failure.
- Release 1 ships only `cdktn`/`cdktn-cli` (no `cdktf` alias CLI).
- Internal symbols and logical IDs remain unchanged in Release 1.
- Legacy config/env keys remain supported in Release 1.
- Migration tool can be built-in or separate (no preference).
- Docs and website updates occur only after packages are built, tested, and released.
- Prebuilt providers: Release 1 requires `cdktn` as peer dependency (major bump), while old `cdktf` users stay on last `cdktf` release.

## Release 1 Goal

Deliver `cdktn` packages under new scope/name with minimal behavioral change to existing apps and state. The only expected change for users is dependency and import/package names, plus CLI command name.

## Phases and Milestones (Release 1 Only)

### Phase 0: Scope Freeze and Branch Readiness

Milestones:

- Confirm package list to rename (core, cli, commons, cli-core, provider-generator, hcl2cdk, prebuilt providers).
- Confirm scope/name targets: `@cdktn/*`, `cdktn`, `cdktn-cli`.
- Confirm compatibility stance: no symbol/ID change, legacy config/env supported.
- Lock on release numbering: pre-1.0 (e.g., `0.x`).

### Phase 1: Core Package Renames (Non-breaking internals)

Milestones:

- Rename package names/scopes in `package.json` and build outputs.
- Update jsii config mappings to new foreign-language namespaces.
- Update internal import paths to new package names.
- Keep symbols and logical IDs unchanged (e.g., `Symbol.for("cdktf/*")`, `__cdktf_*`).
- Ensure outputs still use `cdktf.json`, `cdktf.out`, `.cdktf`, and `CDKTF_*` defaults.

### Phase 2: CLI Rename and Compatibility Surface

Milestones:

- Publish `cdktn-cli` only; no `cdktf` CLI alias.
- Update CLI help, log messages, and user-facing text to `cdktn`.
- Ensure CLI still accepts legacy config/environment keys (e.g., `cdktf.json`, `CDKTF_*`).
- Update CLI templates/scaffolds to new package names while preserving file naming (`cdktf.json`).

### Phase 3: Prebuilt Provider Transition

Milestones:

- Major-bump all prebuilt providers to require `cdktn` as peer dependency.
- Ensure provider metadata still points to Terraform provider sources unchanged.
- Verify provider generator outputs reference new package names but maintain compatible runtime behavior.

### Phase 4: Migration Tooling

Milestones:

- Implement migration helper for import/package renames (regex-based or AST where practical).
- Document migration steps for all languages (minimal scope: imports and package references).
- Ship tool with CLI or as separate package (no preference).

### Phase 5: Validation and Release

Milestones:

- Run CI checks and targeted integration tests for all languages.
- Publish new packages and providers to registries.
- Validate end-to-end: create app with `cdktn`, run `cdktn synth`, run provider `cdktn get`.
- Only after release: begin website/docs update work (out of scope for Release 1).

## Work Split (Suggested)

### Core Library Team

Focus: `packages/cdktf` and related jsii mappings.

- Package rename, jsii namespace mapping updates.
- Ensure symbols/logical IDs remain unchanged.
- Maintain legacy config keys and defaults.

### CLI Team

Focus: `packages/cdktf-cli`, `packages/@cdktf/cli-core`.

- Rename CLI package and update user-facing text.
- Ensure CLI templates generate `cdktn` package dependencies while keeping `cdktf.json`.
- Ensure version checks and diagnostics refer to `cdktn`.

### Provider Tooling Team

Focus: `packages/@cdktf/provider-generator`, prebuilt provider repos.

- Update generator output to new package names.
- Major bump prebuilt provider packages to peer-depend on `cdktn`.
- Validate that runtime expectations remain unchanged.

### Migration Tooling Team

Focus: migration helper and language-specific guides.

- Implement import/package renames for TS/Python/Java/C#/Go.
- Provide a safe default mode (dry-run, reporting).
- Support multi-package workspaces.

### Release & Validation Team

Focus: test, publish, verify.

- Build and test all language targets.
- Coordinate release versions across packages and providers.
- Publish packages and verify basic workflows.

## Ordering and Blocking Dependencies

Blocking tasks:

- Final package naming + jsii namespace mapping decisions (blocks all renames).
- Provider peer-dependency bump policy (blocks provider release).
- CLI templates update (blocks new user bootstrap flows).

Recommended order:

1. Core package renames and jsii mapping updates.
2. CLI rename and template updates.
3. Provider generator updates.
4. Prebuilt provider bumps and publishes.
5. Migration tool finalization.
6. End-to-end test and release.

## Out of Scope for Release 1

- Logical ID changes (`__cdktf_*` -> `__cdktn_*`).
- Internal symbol string changes (`Symbol.for("cdktf/*")`).
- Docs and website updates (after release).
- Compatibility report generation.

## Release 2 Preview (Not Planned Here)

- Switch logical IDs and symbols to `cdktn` namespace.
- Provide state move guidance or automated migration steps.
- Potentially drop legacy config/env keys.
