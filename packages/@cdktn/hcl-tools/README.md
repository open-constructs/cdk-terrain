# `@cdktn/hcl-tools`

This library is meant to house commonly used HCL tools by CDKTN. Currently, it only
supports the [hclwrite](https://pkg.go.dev/github.com/hashicorp/hcl/v2/hclwrite) Golang library and
specifically the [`Format`](https://pkg.go.dev/github.com/hashicorp/hcl/v2/hclwrite#Format) function.

## Usage

```
import { format } from "@cdktn/hcl-tools";

const unformattedHcl = `
resource "random_pet" "my_pet" {
}
`

const formatted = await format(unformattedHcl);

```
