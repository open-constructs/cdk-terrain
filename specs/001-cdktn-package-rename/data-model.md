# Data Model: CDKTN Package Mapping

**Feature Branch**: `001-cdktn-package-rename`
**Date**: 2026-01-14

This document defines the complete mapping of package names, namespaces, and identifiers from `cdktf` to `cdktn`.

> **Note**: This is the authoritative source for package mappings, Symbol.for() strings, and namespace definitions. Other documents (research.md, quickstart.md) should reference this document rather than duplicate content.

## Terminology

| Term                    | Definition                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| **Published languages** | Languages with packages published to public registries: TypeScript (npm), Python (PyPI), Go (GitHub) |
| **Supported languages** | All languages with generated bindings: TypeScript, Python, Go, Java, C# (includes built-only)        |
| **Prebuilt providers**  | Provider packages published to registries (e.g., `@cdktn/provider-aws`)                              |
| **Local providers**     | Provider bindings generated via `cdktn get`                                                          |

## Package Identity Mapping

### NPM Packages

| Current Package             | New Package                 | Registry |
| --------------------------- | --------------------------- | -------- |
| `cdktf`                     | `cdktn`                     | npm      |
| `cdktf-cli`                 | `cdktn-cli`                 | npm      |
| `@cdktf/cli-core`           | `@cdktn/cli-core`           | npm      |
| `@cdktf/commons`            | `@cdktn/commons`            | npm      |
| `@cdktf/hcl-tools`          | `@cdktn/hcl-tools`          | npm      |
| `@cdktf/hcl2cdk`            | `@cdktn/hcl2cdk`            | npm      |
| `@cdktf/hcl2json`           | `@cdktn/hcl2json`           | npm      |
| `@cdktf/provider-generator` | `@cdktn/provider-generator` | npm      |
| `@cdktf/provider-schema`    | `@cdktn/provider-schema`    | npm      |

### Cross-Language Packages

| Language | Current                                       | New                                               | Registry      |
| -------- | --------------------------------------------- | ------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| Python   | `cdktf`                                       | `cdktn`                                           | PyPI          |
| Java     | `com.hashicorp:cdktf`                         | `io.cdktn:cdktn`                                  | Maven Central | <!-- Note: io.cdktn.cdktn import path follows Java groupId.artifactId convention --> |
| C#       | `HashiCorp.Cdktf`                             | `Io.Cdktn`                                        | NuGet         |
| Go       | `github.com/hashicorp/terraform-cdk-go/cdktf` | `github.com/open-constructs/cdk-terrain-go/cdktn` | Go Modules    |

### Prebuilt Providers (External Repos)

| Current Pattern                             | New Pattern                                    | Registry   |
| ------------------------------------------- | ---------------------------------------------- | ---------- |
| `@cdktf/provider-{name}`                    | `@cdktn/provider-{name}`                       | npm        |
| `cdktf-cdktf-provider-{name}`               | `cdktn-provider-{name}`                        | PyPI       |
| `github.com/cdktf/cdktf-provider-{name}-go` | `github.com/cdktn-io/cdktn-provider-{name}-go` | Go Modules |

> **Note**: Prebuilt providers are currently published to npm, PyPI, and Go modules only. Java (Maven Central) and C# (NuGet) prebuilt provider publishing may be added in future releases.

## Namespace Mapping

### TypeScript/JavaScript

```typescript
// Old
import { App, TerraformStack } from "cdktf";
import { AwsProvider } from "@cdktf/provider-aws";

// New
import { App, TerraformStack } from "cdktn";
import { AwsProvider } from "@cdktn/provider-aws";
```

### Python

```python
# Old
from cdktf import App, TerraformStack
from cdktf_cdktf_provider_aws import AwsProvider

# New
from cdktn import App, TerraformStack
from cdktn_provider_aws import AwsProvider
```

### Go

```go
// Old - Core library
import "github.com/hashicorp/terraform-cdk-go/cdktf"

// New - Core library
import "github.com/open-constructs/cdk-terrain-go/cdktn"

// Old - Prebuilt provider
import "github.com/cdktf/cdktf-provider-aws-go/aws/v19/provider"

// New - Prebuilt provider
import "github.com/cdktn-io/cdktn-provider-aws-go/aws/v20/provider"
```

### Java

> **Note**: Java prebuilt providers (`@cdktn/provider-*`) are not yet available. For Release 1, Java users must continue using the existing CDKTF-based providers (`com.hashicorp.cdktf.providers.*`) or generate local providers via `cdktn get`.

```java
// Old - Core library
import com.hashicorp.cdktf.App;
import com.hashicorp.cdktf.TerraformStack;

// New - Core library
import io.cdktn.cdktn.App;
import io.cdktn.cdktn.TerraformStack;

// Prebuilt providers: Use existing CDKTF providers until @cdktn versions are available
// import com.hashicorp.cdktf.providers.aws.provider.AwsProvider;
```

### C#

> **Note**: C# prebuilt providers (`Io.Cdktn.Providers.*`) are not yet available. For Release 1, C# users must continue using the existing CDKTF-based providers (`HashiCorp.Cdktf.Providers.*`) or generate local providers via `cdktn get`.

```csharp
// Old - Core library
using HashiCorp.Cdktf;

// New - Core library
using Io.Cdktn;

// Prebuilt providers: Use existing CDKTF providers until Io.Cdktn.Providers versions are available
// using HashiCorp.Cdktf.Providers.Aws;
```

## Preserved Identifiers (NO CHANGE)

### Internal Symbols

These Symbol.for() strings MUST remain unchanged for backward compatibility:

```typescript
// Core Type Markers
Symbol.for("cdktf/App");
Symbol.for("cdktf/TerraformStack");
Symbol.for("cdktf/TerraformElement");
Symbol.for("cdktf/TerraformResource");
Symbol.for("cdktf/TerraformProvider");
Symbol.for("cdktf/TerraformDataSource");
Symbol.for("cdktf/TerraformOutput");
Symbol.for("cdktf/TerraformBackend");
Symbol.for("cdktf/TerraformCount");
Symbol.for("cdktf/TerraformDynamicBlock");
Symbol.for("cdktf/customSynthesis");

// Token Map Cache
Symbol.for("@cdktf/core.TokenMap.STRING");
Symbol.for("@cdktf/core.TokenMap.LIST");
Symbol.for("@cdktf/core.TokenMap.NUMBER");
Symbol.for("@cdktf/core.TokenMap.NUMBER_LIST");
Symbol.for("@cdktf/core.TokenMap.MAP");

// Module Asset
Symbol.for("cdktf.TerraformModuleAsset");

// External (AWS CDK interop)
Symbol.for("@aws-cdk/core.DependableTrait");
```

### Synthesized Logical IDs

Terraform logical IDs in synthesized JSON MUST remain unchanged:

- `__cdktf_module_asset`
- Other `__cdktf_*` prefixed identifiers

### Configuration Paths

| Item             | Value        | Change    |
| ---------------- | ------------ | --------- |
| Config file      | `cdktf.json` | NO CHANGE |
| Output directory | `cdktf.out/` | NO CHANGE |
| Home directory   | `~/.cdktf`   | NO CHANGE |
| Log file         | `cdktf.log`  | NO CHANGE |

### Environment Variables

All `CDKTF_*` environment variables remain supported:

- `CDKTF_HOME`
- `CDKTF_LOG_LEVEL`
- `CDKTF_LOG_FILE_DIRECTORY`
- `CDKTF_DISABLE_PLUGIN_CACHE_ENV`
- `CDKTF_CONTEXT_JSON`

## CLI Command Mapping

| Current Command          | New Command              |
| ------------------------ | ------------------------ |
| `cdktf init`             | `cdktn init`             |
| `cdktf get`              | `cdktn get`              |
| `cdktf synth`            | `cdktn synth`            |
| `cdktf diff`             | `cdktn diff`             |
| `cdktf deploy`           | `cdktn deploy`           |
| `cdktf destroy`          | `cdktn destroy`          |
| `cdktf convert`          | `cdktn convert`          |
| `cdktf watch`            | `cdktn watch`            |
| `cdktf output`           | `cdktn output`           |
| `cdktf debug`            | `cdktn debug`            |
| `cdktf provider add`     | `cdktn provider add`     |
| `cdktf provider upgrade` | `cdktn provider upgrade` |
| `cdktf provider list`    | `cdktn provider list`    |
| N/A                      | `cdktn migrate` (NEW)    |

## JSII Configuration Mapping

### packages/cdktf/package.json

```json
{
  "name": "cdktn",
  "jsii": {
    "outdir": "dist",
    "versionFormat": "short",
    "license": "MPL-2.0",
    "author": {
      "name": "OpenConstructs",
      "organization": true
    },
    "targets": {
      "python": {
        "distName": "cdktn",
        "module": "cdktn"
      },
      "java": {
        "package": "io.cdktn.cdktn",
        "maven": {
          "groupId": "io.cdktn",
          "artifactId": "cdktn"
        }
      },
      "dotnet": {
        "packageId": "Io.Cdktn",
        "namespace": "Io.Cdktn"
      },
      "go": {
        "moduleName": "github.com/open-constructs/cdk-terrain-go",
        "packageName": "cdktn"
      }
    }
  }
}
```

## Validation Rules

### Package Name Format

- NPM scope: `@cdktn/` (lowercase)
- PyPI: `cdktn` or `cdktn-provider-{name}` (lowercase, hyphen-separated)
- Maven: `io.cdktn:{artifact}` (lowercase)
- NuGet: `Io.Cdktn` or `Io.Cdktn.Providers.{Name}` (PascalCase)
- Go: `github.com/open-constructs/cdk-terrain-go/cdktn` (lowercase)

### Import Statement Format

- TypeScript: `from "cdktn"` or `from "@cdktn/{package}"`
- Python: `from cdktn import ...` or `from cdktn_{provider} import ...`
- Java: `import io.cdktn.cdktn.*;`
- C#: `using Io.Cdktn;`
- Go: `import "github.com/open-constructs/cdk-terrain-go/cdktn"`

### Terraform Provider Sources (NO CHANGE)

Provider source addresses remain unchanged:

- `hashicorp/aws` (NOT `cdktn/aws`)
- `hashicorp/azurerm`
- `hashicorp/google`
- etc.
