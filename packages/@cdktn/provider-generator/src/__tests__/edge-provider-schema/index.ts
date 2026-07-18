// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { ProviderSchema, FunctionSignature } from "@cdktn/commons";
import { schema, SchemaBuilder as S } from "./builder";

const required_attribute_resource = new S()
  .addAllPrimitiveTypes({ required: true, computed: false })
  .addAllPrimitiveListTypes({ required: true, computed: false })
  .build();

const optional_attribute_resource = new S()
  .addAllPrimitiveTypes({ required: false, computed: false })
  .addAllPrimitiveListTypes({ required: false, computed: false })
  // Write-only attribute (RFC-04 / protocol v6): exercises the deprecated
  // getter + `registerProviderFeatureUsage` setter/constructor guards on an
  // existing managed resource. Left optional so no existing usage of
  // OptionalAttributeResource across the edge test suite needs updating.
  .attribute({
    name: "secretWo",
    type: "string",
    required: false,
    computed: false,
    writeOnly: true,
  })
  .build();

const optional_computed_attribute_resource = new S()
  .addAllPrimitiveTypes({ required: false, computed: true })
  .addAllPrimitiveListTypes({ required: false, computed: true })
  .build();

const list_block_resource = new S()
  .listBlock({
    name: "opt",
    block: new S().addAllPrimitivePermutations().asBlock(),
    minItems: 0,
    maxItems: 42,
  })
  .listBlock({
    name: "req",
    block: new S().addAllPrimitivePermutations().asBlock(),
    minItems: 1,
    maxItems: 42,
  })
  .listBlock({
    name: "singleopt",
    block: new S().addAllPrimitivePermutations().asBlock(),
    minItems: 0,
    maxItems: 1,
  })
  .listBlock({
    name: "singlereq",
    block: new S().addAllPrimitivePermutations().asBlock(),
    minItems: 1,
    maxItems: 1,
  })
  .listBlock({
    name: "singleComputedBlock",
    block: new S()
      .attribute({
        computed: true,
        name: "computed",
        type: "string",
        required: false,
        optional: false,
      })
      .attribute({
        computed: false,
        name: "configured",
        type: "string",
        required: false,
      })
      .asBlock(),
    minItems: 0,
    maxItems: 1,
  })
  .attribute({
    name: "computedListOfObject",
    type: [
      "list",
      [
        "object",
        {
          str: "string",
        },
      ],
    ],
    computed: true,
    optional: false,
  })
  .attribute({
    name: "computedListOfMapOfObject",
    type: [
      "list",
      [
        "map",
        [
          "object",
          {
            str: "string",
            other: "string",
          },
        ],
      ],
    ],
    computed: true,
    optional: false,
  })
  .build();

const map_list_resource = new S()
  .attribute({
    name: "mapListOfObject",
    type: [
      "map",
      [
        "list",
        [
          "object",
          {
            hello: "string",
          },
        ],
      ],
    ],
    computed: false,
    optional: false,
  })
  .build();

const map_resource = new S()
  .attribute({
    name: "optMap",
    type: ["map", "string"],
    required: false,
    computed: false,
  })
  .attribute({
    name: "reqMap",
    type: ["map", "bool"],
    required: true,
    computed: false,
  })
  .attribute({
    name: "computedMap",
    type: ["map", "number"],
    required: false,
    computed: true,
  })
  .build();

const set_block_resource = new S()
  .setBlock({
    name: "set",
    block: new S().addAllPrimitivePermutations().asBlock(),
  })
  .build();

// A modest ephemeral resource (plugin protocol v6 / RFC-04): a required
// string, an optional number, a computed attribute, and a nested single
// block - consistent with the primitive/nested-block conventions used by
// the resources above.
const cached_secret = new S()
  .attribute({ name: "str", type: "string", required: true })
  .attribute({ name: "num", type: "number", required: false })
  .attribute({
    name: "computedStr",
    type: "string",
    computed: true,
    optional: false,
  })
  .singleBlock({
    name: "nested",
    block: new S()
      .attribute({ name: "str", type: "string", required: false })
      .attribute({ name: "num", type: "number", required: false })
      .asBlock(),
  })
  .build();

// Provider-defined functions (Terraform >=1.8 / protocol v6), each
// exercising a distinct generator branch of `provider-function-model.ts`.
// Reuses shapes from `provider-functions-synthetic.test.fixture.json` where
// sensible, renamed to fit the edge fixture's naming.
const functions: { [name: string]: FunctionSignature } = {
  // Simple string -> string function.
  greet: {
    description: "Returns a friendly greeting for the given name.",
    summary: "Greet a name",
    return_type: "string",
    parameters: [{ name: "name", type: "string" }],
  },
  // Nullable TRAILING fixed param: becomes jsii-optional.
  greet_with_title: {
    description: "Greets the given name, optionally with a title.",
    summary: "Greet with an optional title",
    return_type: "string",
    parameters: [
      { name: "name", type: "string" },
      { name: "title", type: "string", is_nullable: true },
    ],
  },
  // Nullable MID-POSITION fixed param followed by a required param: stays
  // positional, widens to `any` so a caller can still pass an explicit null.
  join_prefixed: {
    description: "Joins a possibly-null prefix with a required suffix.",
    summary: "Join with a nullable prefix",
    return_type: "string",
    parameters: [
      { name: "prefix", type: "string", is_nullable: true },
      { name: "suffix", type: "string" },
    ],
  },
  // Nullable VARIADIC param: rest parameter widens to `any[]`.
  describe_items: {
    description: "Joins a label with any number of possibly-null items.",
    summary: "Describe items with a label",
    return_type: "string",
    parameters: [{ name: "label", type: "string" }],
    variadic_parameter: { name: "items", type: "string", is_nullable: true },
  },
  // Variadic of bool: union element type -> Array<boolean | IResolvable>
  // rest param.
  all_true: {
    description: "Returns true if every given flag is true.",
    summary: "All flags true",
    return_type: "bool",
    variadic_parameter: { name: "flags", type: "bool" },
  },
  // deprecation_message present (Terraform >=1.8 only, see FunctionSignature
  // docstring) -> surfaced as an `@deprecated` JSDoc tag.
  legacy_greet: {
    description:
      "A deprecated greeting helper kept for backwards compatibility.",
    summary: "Legacy greet",
    deprecation_message: "Use greet instead.",
    return_type: "string",
    parameters: [{ name: "name", type: "string" }],
  },
  // Returns ["object", {...}].
  build_info: {
    description:
      "Returns an object describing the build that produced the given seed.",
    summary: "Build info",
    return_type: ["object", { version: "string", revision: "string" }],
    parameters: [{ name: "seed", type: "string" }],
  },
  // Returns ["list", "number"].
  list_squares: {
    description:
      "Returns the squares of the numbers from 1 to the given count.",
    summary: "List squares",
    return_type: ["list", "number"],
    parameters: [{ name: "count", type: "number" }],
  },
  // A ["map", "string"] param.
  render_tags: {
    description: "Renders the given map of string tags as a single string.",
    summary: "Render tags",
    return_type: "string",
    parameters: [{ name: "tags", type: ["map", "string"] }],
  },
};

export const edgeSchema: ProviderSchema = schema({
  name: "edge",
  provider: new S().addAllPrimitivePermutations().build(),
  resources: {
    required_attribute_resource,
    optional_attribute_resource,
    optional_computed_attribute_resource,
    list_block_resource,
    map_resource,
    set_block_resource,
    map_list_resource,
  },
  dataSources: {},
  ephemeralResources: {
    cached_secret,
  },
  functions,
});
