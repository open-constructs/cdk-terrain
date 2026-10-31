# `@cdktn/hcl-tools`

This library is meant to house commonly used HCL tools by CDKTN. Currently, it only
supports the [hclwrite](https://pkg.go.dev/github.com/hashicorp/hcl/v2/hclwrite) Golang library and
specifically the [`Format`](https://pkg.go.dev/github.com/hashicorp/hcl/v2/hclwrite#Format) function.

CDK Terrain (CDKTN) is the community-maintained successor to CDK for Terraform (CDKTF). Migrating from CDKTF? Follow the [migration guide](https://cdktn.io/docs/release/upgrade-guide-v0-22).

## Use with AI agents

The CDKTN docs are served to AI coding agents by a hosted [MCP server](https://cdktn.io/docs/ai-agents) at `https://cdktn.io/docs/mcp` (streamable HTTP, no auth). Point your agent at it rather than relying on prior CDKTF knowledge:

```bash
claude mcp add --transport http cdktn https://cdktn.io/docs/mcp
```

An [agent skill](https://cdktn.io/docs/skill.md) and an [llms.txt index](https://cdktn.io/llms.txt) are also available.

## Usage

```
import { format } from "@cdktn/hcl-tools";

const unformattedHcl = `
resource "random_pet" "my_pet" {
}
`

const formatted = await format(unformattedHcl);

```
