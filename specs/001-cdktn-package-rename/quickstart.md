# Migration Guide: CDKTF to CDKTN

**Feature Branch**: `001-cdktn-package-rename`
**Date**: 2026-01-14

This guide helps existing CDKTF users migrate their projects to the community-maintained CDKTN packages.

## Overview

The migration from `cdktf` to `cdktn` involves:

1. Updating package dependencies
2. Updating import statements
3. Optionally using the `cdktn migrate` command

**Important**: Your existing Terraform state is NOT affected. The synthesized output remains compatible.

## Quick Start (Automated)

Run the migration tool:

```bash
# Install the new CLI
npm install -g cdktn-cli

# Run migration (dry-run first)
cdktn migrate --dry-run

# Apply migration
cdktn migrate
```

## Manual Migration by Language

### TypeScript/JavaScript

**1. Update package.json dependencies:**

```diff
{
  "dependencies": {
-   "cdktf": "^0.21.0",
+   "cdktn": "^0.22.0",
-   "@cdktf/provider-aws": "^19.0.0"
+   "@cdktn/provider-aws": "^20.0.0"
  },
  "devDependencies": {
-   "cdktf-cli": "^0.21.0"
+   "cdktn-cli": "^0.22.0"
  }
}
```

> NOTE: The CDKTN Release 1 version MUST be the next logical version CDKTF would have (this is already handled by the repository built-in release flows thanks to the mirrored git tags)

**2. Update imports:**

```diff
- import { App, TerraformStack, TerraformOutput } from "cdktf";
+ import { App, TerraformStack, TerraformOutput } from "cdktn";

- import { AwsProvider } from "@cdktf/provider-aws/lib/provider";
+ import { AwsProvider } from "@cdktn/provider-aws/lib/provider";
```

**3. Update npm scripts:**

```diff
{
  "scripts": {
-   "get": "cdktf get",
-   "synth": "cdktf synth"
+   "get": "cdktn get",
+   "synth": "cdktn synth"
  }
}
```

**4. Reinstall dependencies:**

```bash
rm -rf node_modules package-lock.json
npm install
```

### Python

**1. Update requirements.txt or Pipfile:**

```diff
- cdktf>=0.21.0
+ cdktn>=0.22.0

- cdktf-cdktf-provider-aws>=19.0.0
+ cdktn-provider-aws>=20.0.0
```

**2. Update imports:**

```diff
- from cdktf import App, TerraformStack, TerraformOutput
+ from cdktn import App, TerraformStack, TerraformOutput

- from cdktf_cdktf_provider_aws.provider import AwsProvider
+ from cdktn_provider_aws.provider import AwsProvider
```

**3. Reinstall dependencies:**

```bash
pip install -r requirements.txt --force-reinstall
# or with pipenv
pipenv install --dev
```

### Go

**1. Update go.mod:**

```diff
require (
-   github.com/hashicorp/terraform-cdk-go/cdktf v0.21.0
+   github.com/open-constructs/cdk-terrain-go/cdktn v0.22.0
)
```

**2. Update imports:**

```diff
- import "github.com/hashicorp/terraform-cdk-go/cdktf"
+ import "github.com/open-constructs/cdk-terrain-go/cdktn"

// Update all cdktf.* references to cdktn.*
- app := cdktf.NewApp(nil)
+ app := cdktn.NewApp(nil)
```

**3. Update modules:**

```bash
go mod tidy
```

### Java

**1. Update build.gradle:**

```diff
dependencies {
-   implementation "com.hashicorp:cdktf:0.21.0"
+   implementation "io.cdktn:cdktn:0.22.0"
}
```

**2. Update imports:**

```diff
- import com.hashicorp.cdktf.App;
- import com.hashicorp.cdktf.TerraformStack;
+ import io.cdktn.cdktn.App;
+ import io.cdktn.cdktn.TerraformStack;
```

**3. Rebuild:**

```bash
./gradlew build
```

### C#

**1. Update .csproj:**

```diff
<ItemGroup>
-   <PackageReference Include="HashiCorp.Cdktf" Version="0.21.0" />
+   <PackageReference Include="Io.Cdktn" Version="0.22.0" />
</ItemGroup>
```

**2. Update using directives:**

```diff
- using HashiCorp.Cdktf;
+ using Io.Cdktn;
```

**3. Restore packages:**

```bash
dotnet restore
```

## What Stays the Same

The following items are unchanged and backward compatible:

| Item                       | Value                 | Notes             |
| -------------------------- | --------------------- | ----------------- |
| Configuration file         | `cdktf.json`          | No rename needed  |
| Output directory           | `cdktf.out/`          | Still the default |
| Environment variables      | `CDKTF_*`             | Still honored     |
| Home directory             | `~/.cdktf`            | Still used        |
| Terraform provider sources | `hashicorp/aws`, etc. | Unchanged         |
| Terraform state            | Your `.tfstate` files | Unaffected        |

## Transitional Period (Dual Dependencies)

If you use prebuilt providers that haven't been updated to `@cdktn/provider-*` yet, you may temporarily have both `cdktf` and `cdktn` installed:

```json
{
  "dependencies": {
    "cdktn": "^0.22.0",
    "@cdktf/provider-aws": "^19.0.0" // Still uses cdktf peer dep
  }
}
```

This is supported but not recommended long-term.

### Bundle Size Impact

When both packages are installed:

- **Bundle size**: Approximately 2x larger (both packages included)
- **Tree-shaking**: Bundlers will remove unused exports, reducing actual impact
- **Shared dependencies**: `constructs` is deduplicated between packages

**Recommendation**: Complete migration promptly to reduce bundle size and complexity.

### Options

1. **Wait**: Use `@cdktf/provider-*` until `@cdktn/provider-*` is released
2. **Generate locally** (Recommended): Use `cdktn get` to generate provider bindings without prebuilt packages

```bash
# Generate local provider bindings (recommended for clean migration)
cdktn get
```

## Verification

After migration, verify your project works:

```bash
# Synthesize
cdktn synth

# Verify output
ls cdktf.out/stacks/*/cdk.tf.json

# Check no cdktf imports remain (TypeScript)
grep -r "from \"cdktf\"" src/
grep -r "from '@cdktf/" src/

# Run tests
npm test
```

## Troubleshooting

### "Module not found" errors

Ensure you've updated ALL imports. Search for remaining `cdktf` references:

```bash
# TypeScript
grep -rn "cdktf" --include="*.ts" --include="*.tsx"

# Python
grep -rn "cdktf" --include="*.py"
```

### Type errors with dual dependencies

If you have both `cdktf` and `cdktn` installed, ensure TypeScript `skipLibCheck` is enabled:

```json
{
  "compilerOptions": {
    "skipLibCheck": true
  }
}
```

### Provider version conflicts

If a prebuilt provider requires a specific `cdktf` version:

1. Check if `@cdktn/provider-*` version is available
2. If not, use `cdktn get` to generate local bindings

### State drift after migration

If you see state drift after migration, verify:

1. Internal symbols were NOT changed (they should still be `cdktf/*`)
2. Logical IDs were NOT changed (still `__cdktf_*`)
3. Run `cdktn diff` to see actual differences

## Getting Help

- GitHub Issues: https://github.com/open-constructs/cdk-terrain/issues
- Documentation: (Coming after Release 1)
