# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current Priority: CDKTN Rename (Release 1)

See `RFCs/RENAME-PLAN.md` for the active rename effort from `cdktf` to `cdktn`. Key constraints:
- Package names change (`@cdktf/*` → `@cdktn/*`, `cdktf` → `cdktn`, `cdktf-cli` → `cdktn-cli`)
- Internal symbols and logical IDs remain unchanged (`Symbol.for("cdktf/*")`, `__cdktf_*`)
- Legacy config/env keys still supported (`cdktf.json`, `CDKTF_*`)
- Prebuilt providers require `cdktn` as peer dependency (major bump)

## Build & Development

```bash
yarn install          # Install dependencies
yarn build            # Build all packages
yarn watch            # Watch mode for development
yarn package          # Build + create distributable packages
```

### Testing

```bash
yarn test             # Run all unit tests
yarn test:update      # Update snapshots

# Integration tests (require yarn package first)
yarn package
yarn integration                              # All integration tests
yarn integration:single -- typescript/synth-app  # Single test
yarn integration:update                       # Update integration snapshots
```

### Running CLI locally

```bash
# After yarn watch, use the local CLI directly:
./packages/cdktf-cli/bundle/bin/cdktf <command>

# Or link globally:
yarn link-packages
cdktf --version  # Should show 0.0.0
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

This is a **JSII monorepo** that compiles TypeScript to Python, Go, Java, and C#.

### Core Packages

| Package | Purpose |
|---------|---------|
| `packages/cdktf` | Core library - defines constructs (TerraformStack, TerraformResource, etc.) |
| `packages/cdktf-cli` | CLI entry point - thin wrapper around cli-core, uses esbuild |
| `packages/@cdktf/cli-core` | CLI implementation - commands, project management, Terraform execution |
| `packages/@cdktf/provider-generator` | Generates TypeScript bindings from Terraform provider schemas |
| `packages/@cdktf/hcl2cdk` | Converts HCL to CDK code (`cdktf convert`) |
| `packages/@cdktf/hcl2json` | WASM-based HCL parser (Go compiled to WASM) |
| `packages/@cdktf/provider-schema` | Fetches and parses Terraform provider schemas |
| `packages/@cdktf/commons` | Shared utilities across packages |

### Key Flows

**Synthesis**: `App` → `TerraformStack` → `synthesize()` → `cdktf.out/stacks/<name>/cdk.tf.json`

**Provider Generation**: Provider schema JSON → `provider-generator` → TypeScript classes → JSII → Python/Go/Java/C#

**HCL Conversion**: HCL files → `hcl2json` (WASM) → JSON AST → `hcl2cdk` → CDK code

### JSII Considerations

- Core `cdktf` library uses JSII for multi-language support
- Changes to public APIs affect all language bindings
- Run `yarn package` to generate all language distributions in `dist/`
- JSII metadata lives in `.jsii` files

## Feature Flags

Feature flags in `packages/cdktf/lib/features.ts` enable breaking behavior changes behind opt-in flags. New projects get flags enabled via `cdktf.json`. Add new flags to `FUTURE_FLAGS` map.

## Constitution

See `.specify/memory/constitution.md` for project principles (YAGNI, KISS, cross-language parity, etc.).

## Commit Style

Use [conventional commits](https://www.conventionalcommits.org/):
- `feat(cli):` / `feat(lib):` / `feat(provider-generator):`
- `fix(cli):` / `fix(lib):`
- `chore:` for docs, CI, non-code changes

## Debugging

```bash
CDKTF_LOG_LEVEL=debug cdktf synth  # Verbose CDKTF output
JSII_DEBUG=1 yarn build            # JSII debug output
```

## Active Technologies
- TypeScript 5.4.5 (strict mode, target ES2018, CommonJS) (001-cdktn-package-rename)
- N/A (no database; file-based config via `cdktf.json`) (001-cdktn-package-rename)

## Recent Changes
- 001-cdktn-package-rename: Added TypeScript 5.4.5 (strict mode, target ES2018, CommonJS)
