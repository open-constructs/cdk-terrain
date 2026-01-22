# Research: CDKTN Package Rename (Release 1)

**Feature Branch**: `001-cdktn-package-rename`
**Date**: 2026-01-14

## Prior Work

No previous Beads issues or tasks found for this feature. This is the initial implementation of the rename effort documented in:
- `RFCs/RENAME.md` - Detailed renaming protocol and decision points
- `RFCs/RENAME-PLAN.md` - Release 1 focused implementation plan

## Research Area 1: JSII Namespace Mappings

### Decision: Update all JSII targets to new namespaces

### Current Configuration (`packages/cdktf/package.json`)

```json
"jsii": {
    "targets": {
        "python": { "distName": "cdktf", "module": "cdktf" },
        "java": { "package": "com.hashicorp.cdktf", "maven": { "groupId": "com.hashicorp", "artifactId": "cdktf" } },
        "dotnet": { "packageId": "HashiCorp.Cdktf", "namespace": "HashiCorp.Cdktf" },
        "go": { "moduleName": "github.com/hashicorp/terraform-cdk-go", "packageName": "cdktf" }
    }
}
```

### New Configuration

| Language | Property | Current | New |
|----------|----------|---------|-----|
| **Python** | distName | `cdktf` | `cdktn` |
| **Python** | module | `cdktf` | `cdktn` |
| **Java** | package | `com.hashicorp.cdktf` | `io.cdktn.cdktn` |
| **Java** | groupId | `com.hashicorp` | `io.cdktn` |
| **Java** | artifactId | `cdktf` | `cdktn` |
| **.NET** | packageId | `HashiCorp.Cdktf` | `Io.Cdktn` |
| **.NET** | namespace | `HashiCorp.Cdktf` | `Io.Cdktn` |
| **Go** | moduleName | `github.com/hashicorp/terraform-cdk-go` | `github.com/open-constructs/cdk-terrain-go` |
| **Go** | packageName | `cdktf` | `cdktn` |

### Rationale
- Per `RFCs/RENAME.md` section 2: Package Renaming & Publication Targets
- JSII will automatically generate correct language-specific distributions

### Alternatives Considered
- Keep some namespaces unchanged (rejected: creates confusion, partial migration)
- Use different naming conventions per language (rejected: KISS - use consistent `cdktn` everywhere)

---

## Research Area 2: Symbol.for() Strings (MUST PRESERVE)

### Decision: Preserve all 18 Symbol.for() strings unchanged

### Complete Symbol Inventory

#### Core Type Markers (`cdktf/*` namespace)
| Symbol | File | Purpose |
|--------|------|---------|
| `"cdktf/App"` | lib/app.ts:12 | App construct identity |
| `"cdktf/TerraformStack"` | lib/terraform-stack.ts:17 | Stack identity |
| `"cdktf/TerraformElement"` | lib/terraform-element.ts:10 | Base element identity |
| `"cdktf/TerraformResource"` | lib/terraform-resource.ts:40 | Resource identity |
| `"cdktf/TerraformProvider"` | lib/terraform-provider.ts:14 | Provider identity |
| `"cdktf/TerraformDataSource"` | lib/terraform-data-source.ts:28 | Data source identity |
| `"cdktf/TerraformOutput"` | lib/terraform-output.ts:13 | Output identity |
| `"cdktf/TerraformBackend"` | lib/terraform-backend.ts:8 | Backend identity |
| `"cdktf/TerraformCount"` | lib/terraform-count.ts:5 | Count identity |
| `"cdktf/TerraformDynamicBlock"` | lib/terraform-dynamic-block.ts:9 | Dynamic block identity |
| `"cdktf/customSynthesis"` | lib/synthesize/synthesizer.ts:182 | Custom synthesis marker |

#### Token Map Cache Symbols (`@cdktf/core.TokenMap.*` namespace)
| Symbol | File | Purpose |
|--------|------|---------|
| `"@cdktf/core.TokenMap.STRING"` | lib/tokens/private/token-map.ts:20 | String token cache |
| `"@cdktf/core.TokenMap.LIST"` | lib/tokens/private/token-map.ts:21 | List token cache |
| `"@cdktf/core.TokenMap.NUMBER"` | lib/tokens/private/token-map.ts:22 | Number token cache |
| `"@cdktf/core.TokenMap.NUMBER_LIST"` | lib/tokens/private/token-map.ts:23 | Number list token cache |
| `"@cdktf/core.TokenMap.MAP"` | lib/tokens/private/token-map.ts:24 | Map token cache |

#### Module Asset Symbol (different notation)
| Symbol | File | Purpose |
|--------|------|---------|
| `"cdktf.TerraformModuleAsset"` | lib/terraform-module-asset.ts:14 | Module asset identity |

#### External Reference (DO NOT MODIFY)
| Symbol | File | Purpose |
|--------|------|---------|
| `"@aws-cdk/core.DependableTrait"` | lib/tokens/private/dependency.ts:54 | AWS CDK interop |

### Rationale
- Per `RFCs/RENAME-PLAN.md` Phase 1: "Keep symbols and logical IDs unchanged"
- Changing symbols would break runtime type checking across existing projects
- Symbol.for() creates global registry - changing breaks mixed cdktf/cdktn projects
- Release 2 may consider symbol rename with migration tooling

### Alternatives Considered
- Rename symbols to `cdktn/*` (rejected: breaks transitional dual-dependency support, FR-025)
- Add dual symbols (rejected: complexity, maintenance burden, violates KISS)

---

## Research Area 3: CLI Templates

### Decision: Update all template files to reference `cdktn` packages

### Template Files by Language

**TypeScript** (6 files):
- `package.json` - Script commands (`cdktn get`, `cdktn synth`), dependencies
- `main.ts` - Import `from "cdktn"`
- `__tests__/main-test.ts` - Import `"cdktn/lib/testing/adapters/jest"`
- `setup.js` - `require("cdktn")`
- `.hooks.sscaff.js` - Context variables, string replacements
- `help` - Command references, provider URLs

**Python** (pipenv and pip templates) (8 files total):
- `main.py` - `from cdktn import App, TerraformStack`
- `main-test.py` - `from cdktn import Testing`
- `.hooks.sscaff.js` - `pypi_cdktn` context variable
- `help` - PyPI URLs (`cdktn-provider-*`)

**Go** (5 files):
- `main.go` - `"github.com/open-constructs/cdk-terrain-go/cdktn"`
- `main_test.go` - Same import path
- `go.mod` - Module dependency
- `.hooks.sscaff.js` - `go_cdktn` context variable
- `help` - Command references

**Java** (5 files):
- `build.gradle` - `implementation "io.cdktn:cdktn:..."`
- `Main.java` - `import io.cdktn.cdktn.*`
- `MainStack.java` - Same imports
- `MainTest.java` - Same imports
- `.hooks.sscaff.js` - `mvn_cdktn` context variable

**C#** (5 files):
- `Program.cs` - `using Io.Cdktn;`
- `MainStack.cs` - Same using directive
- `TestProgram.cs` - Same using directive
- `MyTerraformStack.csproj` - `<PackageReference Include="Io.Cdktn" />`
- `.hooks.sscaff.js` - `nuget_cdktn` context variable

### Rationale
- Templates define new user experience (User Story 1)
- Must reference correct package names for each language ecosystem

### Alternatives Considered
- Dual templates for cdktf/cdktn (rejected: maintenance burden, user confusion)
- Template generation at runtime (rejected: adds complexity, no benefit)

---

## Research Area 4: Backward Compatibility Paths

### Decision: Preserve all legacy paths in Release 1

### Items to Preserve

| Item | Current | Change | Rationale |
|------|---------|--------|-----------|
| Config file | `cdktf.json` | No change | FR-008 |
| Output dir | `cdktf.out/` | No change | FR-009 |
| Env vars | `CDKTF_*` | No change | FR-010 |
| Home dir | `~/.cdktf` | No change | FR-011 |
| Log file | `cdktf.log` | No change | Legacy compat |
| Symbols | `Symbol.for("cdktf/*")` | No change | FR-012 |
| Logical IDs | `__cdktf_*` | No change | FR-013 |

### Rationale
- Enables migration without breaking existing projects
- Users can adopt `cdktn` CLI with existing config
- Reduces friction in transitional period

### Alternatives Considered
- Support both `cdktf.json` and `cdktn.json` (rejected: clarification session - Release 2)
- Rename everything (rejected: breaks existing projects)

---

## Research Area 5: Migration Tooling

### Decision: Build `cdktn migrate` into CLI

### Migration Command Scope

**Supported Operations:**
1. Update `package.json` / `requirements.txt` / `go.mod` / `build.gradle` / `.csproj` dependencies
2. Update import statements in source files
3. Dry-run mode (preview changes)
4. Recommend `cdktn get` when `@cdktn/provider-*` unavailable

**Language-Specific Patterns:**

| Language | Old Import | New Import |
|----------|------------|------------|
| TypeScript | `from "cdktf"` | `from "cdktn"` |
| TypeScript | `from "@cdktf/*"` | `from "@cdktn/*"` |
| Python | `from cdktf` | `from cdktn` |
| Go | `github.com/hashicorp/terraform-cdk-go/cdktf` | `github.com/open-constructs/cdk-terrain-go/cdktn` |
| Java | `import com.hashicorp.cdktf.*` | `import io.cdktn.cdktn.*` |
| C# | `using HashiCorp.Cdktf` | `using Io.Cdktn` |

### Rationale
- FR-028 through FR-032 require migration tooling
- Built-in CLI provides immediate availability
- Existing patterns in CLI for file manipulation can be reused

### Alternatives Considered
- Separate `@cdktn/migrate` package (noted for future per clarification)
- No tooling, documentation only (rejected: too much manual work for users)

---

## Research Area 6: Sentry Telemetry Integration

### Decision: Re-use existing Sentry patterns

### Current Implementation

**Location**: `@cdktf/cli-core/src/lib/error-reporting.ts`

**Existing Features:**
- Opt-in model via `cdktf.json` `sendCrashReports` boolean
- CI detection (skip reporting in CI)
- Release tag: `cdktf-cli-${DISPLAY_VERSION}`
- Breadcrumb logging for all log levels

### Changes Needed
- Update release tag to `cdktn-cli-${DISPLAY_VERSION}`
- Add migration-specific event tracking (FR-033, FR-034)

### Rationale
- Existing infrastructure is well-tested
- YAGNI - don't build new telemetry system
- Per clarification: re-use Sentry patterns

### Alternatives Considered
- New telemetry system (rejected: YAGNI, existing system works)
- No telemetry (rejected: need migration observability per FR-034)

---

## Pre-Implementation Spike: Dual Dependency Coexistence

### Required Investigation (per clarification session)

This spike validates that `cdktf` and `cdktn` packages can coexist in the same project during the transitional period.

---

### Finding 1: Symbol.for() Behavior Across JS Runtimes

**Investigation**: How does Symbol.for() work when both cdktf and cdktn use the same string keys?

**Key Finding**: `Symbol.for()` creates a **global symbol registry**. The same string key always returns the identical symbol object, regardless of which package calls it.

```typescript
// Both cdktf and cdktn use:
const TERRAFORM_RESOURCE_SYMBOL = Symbol.for("cdktf/TerraformResource");

// This is the SAME symbol in both packages because Symbol.for() is global
```

**Type-Checking Pattern in Codebase**:
```typescript
// From packages/cdktf/lib/terraform-resource.ts
export class TerraformResource extends TerraformElement {
  constructor(...) {
    Object.defineProperty(this, TERRAFORM_RESOURCE_SYMBOL, { value: true });
  }

  public static isTerraformResource(x: any): x is TerraformResource {
    return x !== null && typeof x === "object" && TERRAFORM_RESOURCE_SYMBOL in x;
  }
}
```

**Cross-Package Behavior**:
```typescript
import { TerraformResource as CdktnResource } from "cdktn";
import { TerraformResource as CdktfResource } from "cdktf";

const cdktnInstance = new CdktnResource(stack, "resource", config);

// CRITICAL: This returns TRUE because both use same Symbol.for() string
CdktfResource.isTerraformResource(cdktnInstance); // TRUE
```

**Risk Assessment**:

| Aspect | Risk Level | Notes |
|--------|------------|-------|
| Runtime crashes | **None** | Symbol.for() always succeeds |
| Type check failures | **None** | Both packages register to same symbol |
| False positives | **Medium** | cdktn objects pass cdktf type checks (by design for transitional support) |
| Mixed environments | **Low** | Actually beneficial - allows gradual migration |

**Conclusion**: **NO BLOCKING ISSUES**. The shared Symbol.for() strings are a feature, not a bug - they enable the transitional dual-dependency support (FR-025).

---

### Finding 2: Bundler Behavior (webpack, esbuild, rollup)

**Investigation**: How do bundlers handle two similar packages with overlapping functionality?

**Key Findings**:

1. **Both packages will be included**: Bundlers include all code that is imported. If a project imports from both `cdktf` and `cdktn`, both packages are bundled.

2. **No automatic deduplication**: Unlike multiple versions of the same package, `cdktf` and `cdktn` are distinct packages. Bundlers will not deduplicate them.

3. **Bundle size impact**: Approximately 2x the code if both packages are fully used. However:
   - Tree-shaking removes unused exports
   - Shared dependency (`constructs`) is deduplicated
   - Gzip compression reduces redundancy

4. **Module resolution**: Each package has its own entry point; no resolution ambiguity.

**Mitigation Strategies**:

| Bundler | Configuration | Effect |
|---------|---------------|--------|
| webpack | `resolve.alias` | Can redirect `cdktf` → `cdktn` after full migration |
| esbuild | `external: ["cdktf"]` | Exclude legacy package if not needed |
| rollup | `external` option | Same as esbuild |

**Recommendations**:
- Document that dual dependencies increase bundle size
- Recommend completing migration to remove legacy package
- Users can use `npm dedupe` to optimize shared dependencies

**Risk Assessment**: **LOW** - Bundle size increase is temporary during migration; no functional issues.

Sources:
- [Reduce webpack bundle size by eliminating duplicates](https://www.jakepusateri.com/blog/remove-webpack-duplicates/)
- [webpack and yarn magic against duplicates](https://www.developerway.com/posts/webpack-and-yarn-magic-against-duplicates-in-bundles)
- [duplicate-package-checker-webpack-plugin](https://www.npmjs.com/package/duplicate-package-checker-webpack-plugin)

---

### Finding 3: JSII Kernel and Manifest Implications

**Investigation**: How does JSII handle multiple packages with similar class hierarchies in Python/Java/C#/Go?

**Key Finding**: JSII uses **Fully Qualified Names (FQNs)** that completely separate types across packages.

**FQN Separation by Language**:

| Language | cdktf FQN | cdktn FQN | Conflict? |
|----------|-----------|-----------|-----------|
| Python | `cdktf.TerraformStack` | `cdktn.TerraformStack` | **No** |
| Java | `com.hashicorp.cdktf.TerraformStack` | `io.cdktn.cdktn.TerraformStack` | **No** |
| C# | `HashiCorp.Cdktf.TerraformStack` | `Io.Cdktn.TerraformStack` | **No** |
| Go | `github.com/hashicorp/.../cdktf.TerraformStack` | `github.com/open-constructs/.../cdktn.TerraformStack` | **No** |

**Cross-Language Type Handling**:

```python
# Python - completely separate types
from cdktf import TerraformStack as CdktfStack
from cdktn import TerraformStack as CdktnStack

isinstance(obj, CdktfStack)  # Independent check
isinstance(obj, CdktnStack)  # Independent check
```

```java
// Java - package namespaces disambiguate
com.hashicorp.cdktf.TerraformStack cdktfStack;
io.cdktn.cdktn.TerraformStack cdktnStack;
// Classpath keeps them completely separate
```

**.jsii Manifest Uniqueness**:
- Each package generates its own `.jsii` manifest during `jsii-pacmak`
- Manifest contains unique assembly name (from `package.json` `name` field)
- No conflict because `cdktf` and `cdktn` have different assembly names

**Risk Assessment**: **NONE** - JSII FQNs completely separate types across all languages.

---

### Finding 4: TypeScript Type Definition Conflicts

**Investigation**: Can TypeScript resolve types correctly with both packages installed?

**Potential Issue**: Both packages export identically-named types (e.g., `TerraformStack`).

**Resolution Patterns**:

```typescript
// Pattern 1: Aliased imports (RECOMMENDED)
import { TerraformStack as CdktnStack } from "cdktn";
import { TerraformStack as CdktfStack } from "cdktf";

// Pattern 2: Namespace imports
import * as cdktn from "cdktn";
import * as cdktf from "cdktf";
cdktn.TerraformStack vs cdktf.TerraformStack
```

**tsconfig.json Consideration**:
```json
{
  "compilerOptions": {
    "skipLibCheck": true  // May help if deep type conflicts occur
  }
}
```

**Risk Assessment**: **LOW** - Standard TypeScript aliasing handles this; `skipLibCheck` as fallback.

---

### Finding 5: npm/yarn Peer Dependency Behavior

**Investigation**: How do package managers handle conflicting peer dependencies?

**Scenario**:
- `@cdktf/provider-aws@19.x` → `peerDependency: cdktf`
- `cdktn@0.x` → new core package
- User wants both installed during transition

**Behavior**:
- **npm 7+**: Automatically installs peer dependencies; warns on conflicts but allows install
- **yarn**: Warns but allows installation
- **pnpm**: Strict by default; may need `--shamefully-hoist`

**Transitional Period Support**:
```json
{
  "dependencies": {
    "cdktn": "^0.1.0",
    "@cdktf/provider-aws": "^19.0.0"
  }
}
// Package manager installs both cdktn AND cdktf (via provider peer dep)
```

**Risk Assessment**: **LOW** - Package managers handle this scenario; warnings are expected.

---

### Spike Conclusion

| Area | Risk Level | Blocking? | Notes |
|------|------------|-----------|-------|
| Symbol.for() conflicts | None | **No** | Shared symbols enable transitional support |
| Bundler behavior | Low | **No** | Temporary bundle size increase |
| JSII cross-language | None | **No** | FQNs completely separate types |
| TypeScript types | Low | **No** | Aliased imports resolve conflicts |
| Peer dependencies | Low | **No** | Package managers handle gracefully |

**Overall Assessment**: **NO CRITICAL RISK ITEMS IDENTIFIED**

The dual-dependency coexistence approach is validated. Proceed with implementation.

**Recommendations**:
1. Add runtime warning when both packages detected (optional enhancement)
2. Document bundle size implications in migration guide
3. Recommend completing migration promptly to reduce complexity

---

## Summary: Changes Required

### Files to Modify (Package Identity)

| Package | File | Changes |
|---------|------|---------|
| `cdktf` | `package.json` | name, JSII targets |
| `cdktf-cli` | `package.json` | name, bin entry |
| `@cdktf/cli-core` | `package.json` | name |
| `@cdktf/commons` | `package.json` | name |
| `@cdktf/hcl-tools` | `package.json` | name |
| `@cdktf/hcl2cdk` | `package.json` | name |
| `@cdktf/hcl2json` | `package.json` | name |
| `@cdktf/provider-generator` | `package.json` | name |
| `@cdktf/provider-schema` | `package.json` | name |

### Files to Preserve (Internal Symbols)

All `Symbol.for()` strings remain unchanged - documented above.

### Files to Update (User-Facing Text)

- CLI help text
- Log messages
- Error messages
- Template files
- Example projects
