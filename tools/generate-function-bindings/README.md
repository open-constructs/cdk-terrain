# tools/generate-function-bindings

This package contains tools that work together to generate the bindings for Terraform functions that are part of the `cdktn` package. This is currently a manual process and not yet automated through CI.

## Updating function metadata

CDKTN generates its function bindings from `function-availability/functions-matrix.json`. The matrix holds the signature of every Terraform and OpenTofu function and the releases that provide it.

To add newly released Terraform and OpenTofu versions, run:

```sh
pnpm run update-function-matrix
```

## Generating function bindings

To generate the function bindings from the matrix, run:

```sh
pnpm run generate
```

This will update the generated file in `packages/cdktn/src/functions/terraform-functions.generated.ts`

### Overriding functions

The `scripts/generate.ts` file contains a constant named `INTERNAL_METHODS` that will cause those functions to be internalized (by adding a `_` prefix and the `@internal` docstring required by JSII). This allows to either skip exposing a function or (which we currently use it for) to export that function with a slightly different signature through `packages/cdktn/src/terraform-functions.ts`. We currently do this for some functions that Terraform uses variadic parameters for that would otherwise have a poor UX in CDKTN. Refer to the aforementioned file for examples and more background information.

## Running all generators at once

To run the generators in sequence, run the following command in the root of the repository:

```sh
pnpm install
pnpm run generate-function-bindings
```

This will generate the bindings and the function availability map.
