# Feature Specification: CDKTN Package Rename (Release 1)

**Feature Branch**: `001-cdktn-package-rename`
**Created**: 2026-01-14
**Status**: Draft
**Input**: User description: "Rename packages from cdktf to cdktn for Release 1 of cdk-terrain community fork"

## User Scenarios & Testing _(mandatory)_

### User Story 1 - New User Bootstraps Project (Priority: P1)

A developer new to CDK Terrain wants to start a fresh project using the new `cdktn` packages and CLI, creating infrastructure-as-code without any legacy dependencies.

**Why this priority**: New user experience is critical for adoption of the community fork. If new users cannot start fresh projects, the rename effort provides no value.

**Independent Test**: Can be fully tested by running `npx cdktn-cli init` and verifying the generated project has correct `@cdktn/*` dependencies and runs successfully.

**Acceptance Scenarios**:

1. **Given** a developer has installed `cdktn-cli`, **When** they run `cdktn init --template typescript`, **Then** the generated project contains `cdktn` as a dependency (not `cdktf`) and the project compiles and synthesizes successfully.
2. **Given** a new TypeScript project initialized with `cdktn init`, **When** the developer runs `cdktn synth`, **Then** the synthesized output is written to `cdktf.out/` (legacy default preserved) and contains valid Terraform JSON.
3. **Given** a new project in a published language (TypeScript, Python, Go), **When** the developer follows the initialization flow, **Then** the project uses the appropriate `cdktn` package name for that language ecosystem. _(Note: Java and C# packages will be built but not published to Maven Central or NuGet in Release 1.)_

---

### User Story 2 - Existing User Migrates from CDKTF (Priority: P1)

An existing CDKTF user wants to migrate their project to the community-maintained `cdktn` packages while preserving their existing Terraform state and infrastructure.

**Why this priority**: Migration path for existing users is equally critical. Without a safe migration, existing users cannot adopt the fork without risking infrastructure state issues.

**Independent Test**: Can be fully tested by taking an existing CDKTF project, updating dependencies and imports, and verifying `cdktn synth` produces identical Terraform JSON output.

**Acceptance Scenarios**:

1. **Given** a user has an existing CDKTF project with deployed infrastructure, **When** they update their dependencies from `@cdktf/*` to `@cdktn/*` and update import statements, **Then** running `cdktn synth` produces synthesized output that is functionally identical to their previous output (no state drift).
2. **Given** a migrated project still uses `cdktf.json` as the configuration file, **When** the user runs `cdktn` commands, **Then** the CLI reads and respects the `cdktf.json` configuration without requiring file rename.
3. **Given** a migrated project uses `CDKTF_*` environment variables, **When** the user runs `cdktn` commands, **Then** the CLI honors those environment variables for backward compatibility.
4. **Given** a user has existing `@cdktf/provider-*` prebuilt providers with `cdktf` peer dependency, **When** they install `cdktn` core alongside these providers, **Then** both packages coexist and the project synthesizes correctly (dual dependency transitional support).
5. **Given** a user wants to fully migrate away from `cdktf` dependencies, **When** they run `cdktn migrate`, **Then** the CLI guides them to either switch to `@cdktn/provider-*` (when available) or generate local providers via `cdktn get`.

**Dual Dependency Transitional Period**:

During the transition from `cdktf` to `cdktn`, users with existing `@cdktf/provider-*` prebuilt providers MAY temporarily have both `cdktn` and `cdktf` packages installed. This is supported but carries the following considerations:

> **Note**: The duration of the transitional period is TBD based on community adoption and prebuilt provider availability. End criteria will be defined based on ecosystem feedback.

- **Cautionary Note**: Research is needed to investigate potential concerns in the JavaScript ecosystem with dual package coexistence (symbol conflicts, module resolution, bundle size).
- **Alternative Option A (Clean Break)**: Users can prevent dual dependency by switching entirely to `@cdktn/provider-*` or local providers before migration. This requires `@cdktn/provider-*` to be available.
- **Alternative Option B (Shim/Adapter)**: A future compatibility shim could allow `@cdktf/provider-*` to work with `cdktn` without installing `cdktf`. This is not in scope for Release 1 but noted for future exploration if roadblocks are encountered during testing.

---

### User Story 3 - Developer Uses Prebuilt Providers (Priority: P2)

A developer wants to use prebuilt provider packages (e.g., AWS, Azure, GCP) with their `cdktn` project for rapid development.

**Why this priority**: Prebuilt providers are commonly used for productivity. However, users can use `cdktn get` to generate local providers if prebuilt are unavailable, making this slightly lower priority than core functionality.

**Independent Test**: Can be fully tested by installing a prebuilt provider package and using it in a `cdktn` stack that synthesizes correctly.

**Acceptance Scenarios**:

1. **Given** a developer has a `cdktn` project and `@cdktn/provider-*` packages have been rebuilt with their post-Release 1 major version bump, **When** they install `@cdktn/provider-aws`, **Then** the provider package resolves `cdktn` as its peer dependency and imports work correctly. _(Note: Pre-Release 1 provider versions may still use `cdktf` as a peer dependency during the transitional period.)_
2. **Given** a prebuilt provider is installed, **When** the developer uses provider resources in their stack, **Then** the synthesized Terraform JSON references the correct Terraform provider source (e.g., `hashicorp/aws`) without modification.
3. **Given** `@cdktn/provider-*` packages are released after `cdktn` Release 1, **When** a developer adds them to their project, **Then** they have no `cdktf` peer dependency (clean dependency tree).

**Prebuilt Provider Release Strategy**:

Prebuilt providers (`@cdktn/provider-*`) live in external repositories outside this main `cdk-terrain` repo. The release strategy is:

1. **Release 1 of `cdktn` core** ships first from this repository
2. **Provider repositories** then do a major version bump to adopt `cdktn` Release 1
3. **Rebuilt providers** are published with `cdktn`-only peer dependency (no `cdktf` dependency)
4. **Users on legacy `@cdktf/provider-*`** remain on the last `cdktf`-compatible provider version until they migrate

This sequencing ensures clean dependency trees for new projects while allowing existing users a transitional path.

---

### User Story 4 - Developer Generates Local Providers (Priority: P2)

A developer wants to generate local provider bindings using `cdktn get` for providers without prebuilt packages or for specific provider versions.

**Why this priority**: Local provider generation is a common workflow, especially for custom or less popular providers. It enables full functionality even without prebuilt providers. Critically, this is the **clean migration path** that allows complete removal of `cdktf` dependencies.

**Independent Test**: Can be fully tested by running `cdktn get` with a provider configuration and verifying generated code uses correct `cdktn` imports with zero `cdktf` references.

**Acceptance Scenarios**:

1. **Given** a `cdktf.json` with provider specifications, **When** the developer runs `cdktn get`, **Then** the generated provider code imports from `cdktn` (not `cdktf`) and compiles successfully.
2. **Given** generated providers reference the core library, **When** the provider code is inspected, **Then** all internal references use the new package names while maintaining runtime compatibility.
3. **Given** a user migrating from `@cdktf/provider-*` prebuilt providers, **When** they switch to local provider generation via `cdktn get`, **Then** the generated code has zero `cdktf` package or scope dependencies, allowing full removal of legacy packages.
4. **Given** the provider generator outputs code, **When** the generated `package.json` (or equivalent) is inspected, **Then** it contains only `cdktn` peer dependencies with no `@cdktf/*` references.

**Clean Migration Path**:

Local provider generation via `cdktn get` is the recommended path for users who want to fully remove `cdktf` dependencies immediately. This approach:

- Generates provider bindings that import exclusively from `cdktn`
- Creates no new `cdktf` package or scope dependencies
- Enables prebuilt provider repositories to later use this same generator to publish `@cdktn/provider-*` without legacy dependencies
- Allows users to migrate at their own pace without waiting for all prebuilt providers to be republished

---

### User Story 5 - Developer Converts HCL to CDK (Priority: P3)

A developer wants to convert existing HCL Terraform configurations to CDK code using `cdktn convert`.

**Why this priority**: HCL conversion is a specialized workflow used less frequently than core synthesis. It's valuable for migration but not blocking for basic usage.

**Independent Test**: Can be fully tested by running `cdktn convert` on an HCL file and verifying the output imports from `cdktn`.

**Acceptance Scenarios**:

1. **Given** an existing HCL Terraform file, **When** the developer runs `cdktn convert`, **Then** the generated CDK code imports from `cdktn` and uses `cdktn` package references.

---

### Edge Cases

**Dual Dependency Coexistence (Transitional)**:

- What happens when a project has both `cdktf` and `cdktn` dependencies installed? The system MUST support this transitional state and synthesize correctly. A warning MAY be displayed recommending migration to clean dependencies.
- **Pre-Implementation Spike Required**: Before main implementation begins, conduct a focused spike to validate dual-dependency coexistence. The spike MUST investigate:
  - Symbol conflicts between `cdktf` and `cdktn` runtime symbols
  - Module resolution ambiguity in bundlers (webpack, esbuild, rollup)
  - Bundle size impact of including both packages
  - Type definition conflicts in TypeScript projects
  - JSII cross-language implications (Python, Java, C#, Go)
- **Spike Outcome**: If fatal issues are discovered, the dual-dependency approach must be reconsidered before proceeding. Spike results should be documented in the implementation plan.

**Provider Dependency Mixing**:

- How does the system handle mixed provider versions where some providers (`@cdktf/provider-*`) expect `cdktf` and others (`@cdktn/provider-*`) expect `cdktn`? The package manager should resolve peer dependencies correctly; the CLI should synthesize if all peer dependencies are satisfied.
- What if a user has `@cdktf/provider-aws` (peer depends on `cdktf`) alongside `cdktn` core? This is the supported transitional scenario - both packages coexist.

**Configuration and Environment**:

- What happens when `cdktf.json` contains invalid configuration? The CLI should provide clear error messages with guidance on valid configuration.
- How does the system behave when legacy `~/.cdktf` home directory contains cached data? The CLI should continue to use legacy paths for backward compatibility.

**Provider Generator Output**:

- What if the provider generator is run with an older `cdktf.json` that references `cdktf` in module paths? The generator should output `cdktn` imports regardless of config file naming.
- How does the system handle provider generation when `cdktf` is NOT installed? The generator MUST work with only `cdktn` installed - no implicit `cdktf` dependency.
- How does the system handle provider generation when both `cdktf-cli` and `cdktn-cli` are installed globally? The generator MUST work correctly regardless of which CLIs are installed. The `cdktn` CLI should not conflict with or be affected by an existing `cdktf-cli` installation.

**Migration Tooling**:

- What if `cdktn migrate` is run on a project that is already fully migrated? The tool should detect this and report "no migration needed" without making changes.
- What if migration fails partway through? **Recovery strategy is minimal by design**: The tool MUST display clear warnings before migration recommending users create checkpoints (git commit or backup) before proceeding. The tool operates in dry-run mode by default. No automatic rollback is provided to avoid over-complicating the migration tooling.

## Requirements _(mandatory)_

### Functional Requirements

**Package Identity:**

- **FR-001**: All NPM packages MUST be published under the `@cdktn` scope, replacing `@cdktf`
- **FR-002**: The core library MUST be published as `cdktn` on NPM, replacing `cdktf`
- **FR-003**: The CLI MUST be published as `cdktn-cli` on NPM, replacing `cdktf-cli`
- **FR-004**: The Python package MUST be published as `cdktn` on PyPI with module import `from cdktn import ...`
- **FR-005**: The Go module MUST be available at `github.com/open-constructs/cdk-terrain-go/cdktn`
- **FR-006**: The Maven artifact MUST be built with groupId `io.cdktn` and artifactId `cdktn` _(Note: Built but NOT published to Maven Central in Release 1)_
- **FR-007**: The NuGet package MUST be built as `Io.Cdktn` with namespace `Io.Cdktn` _(Note: Built but NOT published to NuGet in Release 1)_

**Backward Compatibility:**

- **FR-008**: The CLI MUST accept `cdktf.json` as the only configuration filename in Release 1 (no `cdktn.json` alternative)
- **FR-009**: The CLI MUST write synthesized output to `cdktf.out/` by default
- **FR-010**: The CLI MUST honor `CDKTF_*` environment variables
- **FR-011**: The CLI MUST use `~/.cdktf` as the default home directory
- **FR-012**: Internal symbols (e.g., `Symbol.for("cdktf.TerraformModuleAsset")`) MUST remain unchanged in Release 1
- **FR-013**: Synthesized logical IDs (e.g., `__cdktf_module_asset`) MUST remain unchanged in Release 1

**CLI Functionality:**

- **FR-014**: The CLI command MUST be `cdktn` (no `cdktf` alias provided)
- **FR-015**: CLI help text, log messages, and user-facing output MUST reference `cdktn`
- **FR-016**: CLI templates MUST generate projects with `cdktn` dependencies while preserving `cdktf.json` filename

**Provider Support:**

- **FR-017**: Prebuilt provider packages (external repos) MUST be published under `@cdktn/provider-<name>` scope after Release 1
- **FR-018**: Prebuilt providers MUST require `cdktn` as peer dependency (major version bump from previous `cdktf` versions)
- **FR-019**: Provider generator MUST output code referencing `cdktn` packages exclusively (no `cdktf` imports or dependencies). In particular, generated package manifests (package.json, requirements.txt, go.mod, etc.) MUST NOT contain any `@cdktf/*` scope dependencies.
- **FR-020**: Terraform provider source references (e.g., `hashicorp/aws`) MUST NOT change
- **FR-024**: Provider generator MUST function correctly when only `cdktn` is installed (no implicit `cdktf` requirement)

**Dual Dependency Transitional Support:**

- **FR-025**: The CLI MUST synthesize correctly when both `cdktf` and `cdktn` packages are installed in the same project
- **FR-026**: The CLI MAY display a warning when dual dependencies are detected, recommending migration to clean `cdktn`-only dependencies
- **FR-027**: Runtime symbol handling MUST accommodate projects with both `cdktf` and `cdktn` present during the transitional period

**Migration Tooling:**

- **FR-028**: The CLI MUST include a `cdktn migrate` command to assist users in transitioning from `cdktf` to `cdktn`
- **FR-029**: The migration tool MUST support updating import statements across published languages (TypeScript, Python, Go)
- **FR-030**: The migration tool MUST support updating package.json (and equivalent) dependency declarations
- **FR-031**: The migration tool SHOULD support dry-run mode (pre-run validations - is it an existing project using cdktf? do files import the old libraries? prints list of files and changes that would be made without modifying files)
- **FR-032**: The migration tool SHOULD recommend switching to local provider generation (`cdktn get`) when `@cdktn/provider-*` equivalents are not yet available

**Observability:**

- **FR-033**: The CLI MUST re-use existing Sentry telemetry patterns for observability during migration
- **FR-034**: Migration-related events (success, failure, dual-dependency detection) SHOULD be captured using existing telemetry infrastructure

**Future Alternatives (Out of Scope for Release 1)**:

- Migration tooling as a separate `@cdktn/migrate` package may be considered as an alternative approach based on contributor alignment. Benefits include: keeping CLI lean, independent iteration cycles, optional installation.

**Legal Compliance:**

- **FR-021**: Existing copyright headers MUST be preserved as required by MPL-2.0
- **FR-022**: New files MAY include additional `CDK Terrain Maintainers` attribution in the same format

### Key Entities

- **Package Manifest**: Configuration files (package.json, pyproject.toml, pom.xml, etc.) that define package identity, dependencies, and metadata for each language ecosystem
- **JSII Configuration**: TypeScript-to-multi-language compilation settings that map NPM package names to foreign language namespaces (Python modules, Java packages, C# namespaces, Go modules)
- **Project Configuration**: User's project settings file (`cdktf.json`) containing app entry point, providers, feature flags, and output settings
- **Synthesized Output**: Generated Terraform JSON files written to the output directory, containing resource definitions and provider configurations
- **Provider Bindings**: Generated TypeScript classes (and JSII-compiled equivalents) that provide type-safe access to Terraform provider resources and data sources

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: New users can initialize, build, and synthesize a `cdktn` project in all published languages (TypeScript, Python, Go) within 10 minutes following documentation _(Note: Java and C# examples will be functional but packages are not published to Maven Central or NuGet in Release 1)_
- **SC-002**: Existing CDKTF users can migrate their projects to `cdktn` with only dependency and import changes, producing identical synthesized output (zero infrastructure state drift)
- **SC-003**: Prebuilt provider repositories can rebuild and publish under `@cdktn/provider-*` scope using Release 1 provider generator, with `cdktn`-only peer dependency
- **SC-004**: The CLI responds to all commands within the same performance envelope as the previous `cdktf` CLI (no regression beyond measurement variance, approximately ±5%)
- **SC-005**: 100% of CLI commands function correctly when using legacy `cdktf.json` configuration and `CDKTF_*` environment variables
- **SC-006**: Package downloads from new registry locations succeed with correct dependency resolution across all package managers
- **SC-007**: Projects with dual dependencies (`cdktf` + `cdktn`) synthesize correctly during transitional period
- **SC-008**: Local provider generation via `cdktn get` produces code with zero `cdktf` dependencies, enabling full migration
- **SC-009**: The `cdktn migrate` command successfully updates imports and dependencies in test projects across all supported languages

### Previous work

No previous Beads issues or tasks found for this feature. This is the initial specification for the CDKTN rename effort as documented in:

- `RFCs/RENAME.md` - Detailed renaming protocol and decision points
- `RFCs/RENAME-PLAN.md` - Release 1 focused implementation plan

## Assumptions

The following assumptions were made based on the RFC documents and user decisions:

1. **Version Numbering**: Release 1 will start at version `0.22.0`, the next version after the last published `cdktf-cli` version (`0.21.0`). This continues the version sequence to clearly indicate the fork's relationship to the original project.
2. **Registry Access**: The team has publishing access to NPM `@cdktn` scope, PyPI `cdktn`, Maven Central `io.cdktn`, NuGet `Io.Cdktn`, and the GitHub organization for Go modules
3. **Testing Infrastructure**: Existing CI/CD pipelines can be adapted for the renamed packages
4. **Documentation**: Documentation and website updates are explicitly out of scope for Release 1 (will occur after packages are released)
5. **Prebuilt Provider Strategy**: Prebuilt providers live in external repositories and will be determined and added as needed. The team currently has publishing set up for npm, PyPI, and GitHub (Go modules) only - Maven Central and NuGet publishing for prebuilt providers is not available in Release 1. Providers will do a major version bump to adopt `cdktn` Release 1 after it ships and will be rebuilt without `cdktf` dependencies
6. **Dual Dependency Coexistence**: JavaScript ecosystem allows `cdktf` and `cdktn` packages to coexist in the same project without fatal conflicts. A pre-implementation spike is required to validate this assumption before committing to the approach.
7. **Migration Tooling Location**: The `cdktn migrate` command will be built into the CLI for Release 1. A separate `@cdktn/migrate` package may be considered for future releases based on community feedback.
8. **Provider Generator Independence**: The provider generator can function correctly with only `cdktn` installed, without any implicit dependency on `cdktf` being present.
9. **Config Filename**: Only `cdktf.json` is supported in Release 1. A `cdktn.json` alternative may be introduced in Release 2.
10. **Telemetry Infrastructure**: Existing Sentry telemetry patterns are available and can be extended for migration observability.

## Clarifications

### Session 2026-01-14

- Q: Should Release 1 introduce a new canonical config filename `cdktn.json` alongside legacy `cdktf.json` support? → A: `cdktf.json` only in Release 1. Simpler, avoids user confusion about which file takes precedence. New filename can be added in Release 2.
- Q: How should the dual-dependency coexistence research be handled for Release 1? → A: Spike before implementation. Conduct a focused spike to validate dual-dependency coexistence works before main implementation. Blocks if fatal issues found.
- Q: Should the CLI emit logs or telemetry events to help diagnose migration issues? → A: Re-use existing patterns and use of Sentry telemetry for observability during migration.
- Q: How should existing issue links in changelogs and source code be handled? → A: Existing issue links that reference specific issue IDs (e.g., `hashicorp/terraform-cdk#1234`) MUST be preserved unchanged. These are historical references and remain valid. Only newly created issue links should point to the community fork repository (`open-constructs/cdk-terrain`).

## Decisions Log

The following decisions were made during specification refinement:

| Decision                  | Choice                         | Rationale                                                                | Alternatives Noted                                                            |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Dual dependency handling  | Transitional support           | Allows gradual migration without blocking users on provider availability | Clean break (require full migration), Shim/adapter layer (future exploration) |
| Prebuilt provider release | External repos, post-Release 1 | Providers live outside main repo; major bump after core ships            | Bundled release, Delayed provider support                                     |
| Migration tool location   | Built into CLI                 | Immediate availability, single install                                   | Separate `@cdktn/migrate` package (noted for future)                          |
| Config filename           | `cdktf.json` only              | Simpler, avoids precedence confusion                                     | Both filenames with precedence rules (Release 2)                              |
| Dual-dependency research  | Spike before implementation    | Validates assumption before committing to approach; blocks if fatal      | During implementation, Defer to community                                     |
| Observability             | Sentry telemetry               | Re-use existing patterns; consistent with current codebase               | Warning logs only, Opt-in telemetry, No logging                               |
