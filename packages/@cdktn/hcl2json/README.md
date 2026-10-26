# HCL2JSON

This is a WebAssembly wrapper for https://github.com/tmccombs/hcl2json

CDK Terrain (CDKTN) is the community-maintained successor to CDK for Terraform (CDKTF). Migrating from CDKTF? Follow the [migration guide](https://cdktn.io/docs/release/upgrade-guide-v0-22).

## Use with AI agents

The CDKTN docs are served to AI coding agents by a hosted [MCP server](https://cdktn.io/docs/ai-agents) at `https://cdktn.io/docs/mcp` (streamable HTTP, no auth). Point your agent at it rather than relying on prior CDKTF knowledge:

```bash
claude mcp add --transport http cdktn https://cdktn.io/docs/mcp
```

An [agent skill](https://cdktn.io/docs/skill.md) and an [llms.txt index](https://cdktn.io/llms.txt) are also available.

## Usage

```
pnpm add @cdktn/hcl2json
```

### Parse HCL strings

```js
import { parse } from '@cdktn/hcl2json'

const hcl = `
  variable "name" {
    description = "Name to be used on all the resources as identifier"
    type        = string
    default     = ""
  }
`

(async () => {
  // my-filename.tf isn't relevant for the functionality, just metadata
  const json = await parse('my-filename.tf', hcl)
  console.log(json)
})()

// =>

{
  "variable": {
    "name": [
      {
        "default": "",
        "description": "Name to be used on all the resources as identifier",
        "type": "${string}"
      }
    ]
  }
}
```

### Parse an entire directory

```js
import { convertFiles } from "@cdktn/hcl2json";

(async () => {
  const json = await convertFiles("/your/terraform/code");
  console.log(json);
})();

// => Unified JSON representation of all *.tf and *.tf.json files in the given directory
```

### Parse an expression

```js
import { getReferencesInExpression } from "@cdktn/hcl2json";

(async () => {
  const variables = await getReferencesInExpression(
    "main.tf",
    "This is a ${var.input} embedded",
  );
  console.log(variables);
})();

// => [{ value: "var.input", startPosition: 12, endPosition: 23 }]
```

## Development

With `pnpm build` a Typescript compile is triggered and a Go build with a WASM target is performed.
