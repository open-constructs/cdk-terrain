# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Prerequisites & Setup

Tools managed by [mise](https://mise.jdx.dev/) (see `.mise.toml`): Node 20.20, Go 1.18, Python 3.11, Java corretto-20, .NET 6.0, Terraform 1.7.5.

Additional tools **not** managed by mise (install manually):

```bash
# macOS
brew install maven rsync

# Enable corepack for yarn (pinned to 1.18.0 via package.json)
corepack enable
```

Then:

```bash
yarn install
```

See `CONTRIBUTING.md` for full details including Docker-based development and language-specific setup.

## Build & Development

```bash
yarn build            # Build all packages (tsc + jsii)
yarn watch            # Watch mode for development
yarn package          # Build + create distributable packages (requires mvn, rsync)
```

### Testing

```bash
yarn test             # Run all unit tests
yarn test:update      # Update snapshots

# Some unit tests require dist packages to be built first (they auto-skip if missing):
yarn package
yarn test

# Integration tests (always require yarn package first)
yarn package
yarn integration                              # All integration tests
yarn integration:single -- typescript/synth-app  # Single test
yarn integration:update                       # Update integration snapshots
```

On Linux with limited tmpfs: `TMPDIR=/var/tmp yarn test`

### Running CLI locally

```bash
# After yarn watch, use the local CLI directly:
./packages/cdktn-cli/bundle/bin/cdktn <command>

# Or link globally:
yarn link-packages
cdktn --version  # Should show 0.0.0
```

### Language-specific testing

```bash
yarn integration:typescript
yarn integration:python
yarn integration:go
yarn integration:csharp
yarn integration:java
```

## Package Architecture

This is a **JSII monorepo** (Lerna + Yarn workspaces) that compiles TypeScript to Python, Go, Java, and C#.

### Core Packages

| Package                              | Purpose                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/cdktn`                     | Core library — constructs (TerraformStack, TerraformResource, etc.). Uses JSII.                                              |
| `packages/cdktn-cli`                 | CLI entry point — thin wrapper around cli-core, uses esbuild (transpile only, no type checking; tsc runs as pre-commit hook) |
| `packages/@cdktn/cli-core`           | CLI implementation — commands, project management, Terraform execution                                                       |
| `packages/@cdktn/provider-generator` | Generates TypeScript bindings from Terraform provider schemas                                                                |
| `packages/@cdktn/provider-schema`    | Fetches and parses Terraform provider schemas                                                                                |
| `packages/@cdktn/hcl2cdk`            | Converts HCL to CDK code (`cdktn convert`)                                                                                   |
| `packages/@cdktn/hcl2json`           | WASM-based HCL parser (Go compiled to WASM)                                                                                  |
| `packages/@cdktn/commons`            | Shared utilities across packages                                                                                             |

### Key Flows

**Synthesis**: `App` → `TerraformStack` → `synthesize()` → `cdktf.out/stacks/<name>/cdk.tf.json`

**Provider Generation**: Provider schema JSON → `provider-generator` → TypeScript classes → JSII → Python/Go/Java/C#

**HCL Conversion**: HCL files → `hcl2json` (WASM) → JSON AST → `hcl2cdk` → CDK code

### JSII Considerations

- Core `cdktn` library uses JSII for multi-language support
- Changes to public APIs affect all language bindings
- Run `yarn package` to generate all language distributions in `dist/`
- JSII metadata lives in `.jsii` files

## Feature Flags

Feature flags in `packages/cdktn/lib/features.ts` enable breaking behavior changes behind opt-in flags. New projects get flags enabled via `cdktf.json`. Add new flags to `FUTURE_FLAGS` map.

## Constitution

See `.specify/memory/constitution.md` for project principles. Priority order: YAGNI > KISS > UX Consistency > Test Coverage. Small PRs reviewable in <30 minutes preferred.

## Commit Style

Use [conventional commits](https://www.conventionalcommits.org/):

- `feat(cli):` / `feat(lib):` / `feat(provider-generator):`
- `fix(cli):` / `fix(lib):`
- `chore:` for docs, CI, non-code changes

Allowed scopes: `cli`, `lib`, `hcl2cdk`, `hcl2json`, `provider-generator`, `examples`, `tests`, `docs`, `readme`, `release`, `deps`, `gha`

## CI Labels

PR labels control which CI jobs run:

- `ci/skip-integration`, `ci/skip-provider-integration`, `ci/skip-unit`, `ci/skip-examples` — skip test suites
- `ci/unit-only` — skip integration/provider-integration/examples
- `ci/run-unit/<package>` — trigger specific package unit tests (e.g. `ci/run-unit/cdktn`)

## Debugging

```bash
CDKTF_LOG_LEVEL=debug cdktn synth  # Verbose CDKTN output
JSII_DEBUG=1 yarn build            # JSII debug output
```

## Notable changes

### CDKTN Rename

This project was renamed from `cdktf` to `cdktn`. Key constraints:

- Package names change (`@cdktf/*` → `@cdktn/*`, `cdktf` → `cdktn`, `cdktf-cli` → `cdktn-cli`)
- Internal symbols and logical IDs remain unchanged (`Symbol.for("cdktf/*")`, `__cdktf_*`)
- Legacy config/env keys still supported (`cdktf.json`, `CDKTF_*`)
- Prebuilt providers require `cdktn` as peer dependency (major bump)
