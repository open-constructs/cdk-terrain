// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { toCamelCase, toPascalCase } from "codemaker";
import {
  AttributeType,
  FunctionParameter,
  FunctionSignature,
} from "@cdktn/commons";

/**
 * A provider-defined function parameter (positional or the trailing
 * variadic one), mapped to the jsii-safe TypeScript type used in the
 * generated method signature.
 */
export interface ProviderFunctionParameterModel {
  readonly terraformName: string;
  readonly name: string;
  readonly tsType: string;
  readonly docstringType: string;
  readonly description?: string;
  /**
   * True when this (fixed, non-variadic) parameter is emitted as a
   * jsii-optional TypeScript parameter (`name?: T`) - see the
   * is_nullable/trailing-compatibility handling in `applyNullability`.
   * Never set on the variadic parameter: an array parameter can't be `?`.
   */
  readonly optional?: boolean;
}

/**
 * `ProviderFunctionParameterModel` plus the one bit of information that's
 * only needed while building the model (see `mapParameterType`/
 * `applyNullability`), never by the emitter: whether `tsType` already
 * accepts an arbitrary `cdktn.IResolvable` in this position (a bare
 * boolean/collection-of-boolean token, `any`, or an explicit
 * `| cdktn.IResolvable` union already present). Nullability handling uses
 * this to decide whether it needs to append another `| cdktn.IResolvable`
 * so a caller can pass `cdktn.Token.nullValue()` - without resorting to
 * re-deriving that answer with a string search over `tsType`.
 */
interface InternalParameterModel extends ProviderFunctionParameterModel {
  readonly acceptsResolvableAlready: boolean;
}

/**
 * A single provider-defined function, mapped to a static method on the
 * generated `<Provider>ProviderFunctions` class.
 */
export interface ProviderFunctionModel {
  readonly terraformName: string;
  readonly methodName: string;
  readonly description?: string;
  readonly summary?: string;
  /**
   * Terraform (>=1.8) deprecation message for the function, surfaced as an
   * `@deprecated` JSDoc tag. OpenTofu never emits this field - see
   * `FunctionSignature.deprecation_message`.
   */
  readonly deprecationMessage?: string;
  readonly returnTsType: string;
  /**
   * The `@returns {...}` JSDoc type, describing the conceptual/Terraform
   * shape of the return value - see `mapReturnType`. This deliberately can
   * differ from `returnTsType` (e.g. a `bool` return is declared
   * `cdktn.IResolvable` but documented as `boolean | IResolvable`), the same
   * way a parameter's `docstringType` can differ from its `tsType`.
   */
  readonly returnDocstringType: string;
  /**
   * Wraps the `cdktn.TerraformProviderFunction.invoke(...)` call expression
   * into the method's `return` statement (e.g. wrapping it in
   * `cdktn.Token.asString(...)`, or returning it unwrapped for `bool`).
   */
  readonly wrapReturn: (invokeExpression: string) => string;
  readonly parameters: ProviderFunctionParameterModel[];
  readonly variadicParameter?: ProviderFunctionParameterModel;
}

/**
 * All provider-defined functions of a single provider, mapped to a single
 * generated `providers/<provider>/provider-functions/index.ts` file.
 */
export interface ProviderFunctionsModel {
  readonly providerName: string;
  readonly className: string;
  readonly functions: ProviderFunctionModel[];
}

// Parameter names that collide with a reserved word/identifier in one of the
// jsii target languages. This is the sibling table for provider-defined
// functions: tools/generate-function-bindings/scripts/generate.ts holds the
// canonical (and separately maintained) table for built-in `Fn.*` functions.
// The two are intentionally not shared - that script lives outside the
// packages/ build and generates a different artifact - but any reserved name
// added there should be considered here too.
const RESERVED_PARAMETER_NAMES: { [name: string]: string } = {
  default: "defaultValue", // reserved word in TypeScript
  string: "str", // causes issues in Go
};

function sanitizeParameterName(name: string): string {
  const camelCased = toCamelCase(name);
  return RESERVED_PARAMETER_NAMES[camelCased] ?? camelCased;
}

function sanitizeMethodName(name: string): string {
  if (name === "length") return "lengthOf"; // reserved on jsii-generated classes
  return toCamelCase(name);
}

// Members that `ProviderFunctionsEmitter` (see `emitter/provider-functions-emitter.ts`)
// itself puts on every generated `<Provider>ProviderFunctions` wrapper class,
// regardless of which functions a provider declares:
//   - "constructor": the class's own constructor, which takes the provider's
//     `providerLocalName`. A provider-defined function named "constructor"
//     would sanitize to a *second* `constructor` member on the class, which
//     is invalid TypeScript.
//   - "providerLocalName": the `private readonly providerLocalName: string`
//     field the constructor assigns (see the emitter's `emitClassHeader`/
//     constructor emission). A provider-defined function sanitizing to this
//     name would collide with that field.
// If `ProviderFunctionsEmitter` ever grows more members on the wrapper class,
// add them here too.
const RESERVED_WRAPPER_MEMBER_NAMES = new Set([
  "constructor",
  "providerLocalName",
]);

/**
 * Result of mapping a single Terraform attribute type into a jsii-safe
 * parameter shape (see `mapParameterType`).
 */
interface MappedParameterType {
  readonly tsType: string;
  readonly docstringType: string;
  /**
   * True when `tsType` already accepts an arbitrary `cdktn.IResolvable` in
   * this position without needing an extra `| cdktn.IResolvable` union -
   * see `InternalParameterModel`.
   */
  readonly acceptsResolvableAlready: boolean;
}

/**
 * The bracket-composable ("T[]", no top-level union) TypeScript/docstring
 * type for an element that can nest inside an array without ITSELF needing
 * the whole-collection token union at that level: `string`, `number`, or a
 * list/set of one of those, recursively (e.g. `list(list(string))` bottoms
 * out at `string`). Returns `undefined` for anything else (`bool`, `map`,
 * `object`, `dynamic`, or a nested collection that doesn't itself qualify),
 * so the caller falls back to widening the whole parameter to
 * `any[] | cdktn.IResolvable` instead.
 */
function plainArrayElementType(
  type: AttributeType,
): { tsType: string; docstringType: string } | undefined {
  if (type === "string") return { tsType: "string", docstringType: "string" };
  if (type === "number") return { tsType: "number", docstringType: "number" };
  if (Array.isArray(type) && (type[0] === "list" || type[0] === "set")) {
    const inner = plainArrayElementType(type[1]);
    if (!inner) return undefined;
    const label = type[0] === "set" ? "[set] " : "[list] ";
    return {
      tsType: `${inner.tsType}[]`,
      docstringType: `${label}Array<${inner.docstringType}>`,
    };
  }
  return undefined;
}

/**
 * Maps a `list`/`set` parameter to its jsii-safe shape - mirrors
 * `ListAttributeTypeModel`/`SetAttributeTypeModel.inputTypeDefinition`
 * (both identical) branch for branch, since jsii parameters, like resource
 * inputs, are allowed to union in a whole-collection `cdktn.IResolvable`
 * token. `kind` only affects the docstring wording (`[list]`/`[set]`,
 * flagging the ordering/duplicate-element semantics difference to the
 * reader) - the type-level handling is identical for both.
 */
function mapListOrSetParameterType(
  kind: "list" | "set",
  element: AttributeType,
): MappedParameterType {
  const label = kind === "set" ? "[set]" : "[list]";

  if (element === "string") {
    // Mirrors the final `else` branch: encoded list tokens already satisfy
    // `string[]`, so no union is needed.
    return {
      tsType: "string[]",
      docstringType: `${label} Array<string>`,
      acceptsResolvableAlready: false,
    };
  }
  if (element === "number") {
    // Same reasoning as `string` above.
    return {
      tsType: "number[]",
      docstringType: `${label} Array<number>`,
      acceptsResolvableAlready: false,
    };
  }
  if (element === "bool") {
    // Mirrors the `elementType.storedClassType === "boolean"` branch: bool
    // has no lossless per-element token, but the WHOLE collection is still
    // tokenizable, so the union is on the outside.
    return {
      tsType: "Array<boolean | cdktn.IResolvable> | cdktn.IResolvable",
      docstringType: `${label} Array<boolean | IResolvable>`,
      acceptsResolvableAlready: true,
    };
  }

  const plainElement = plainArrayElementType(element);
  if (plainElement) {
    // Mirrors the `elementType.typeModelType !== "simple"` branch: a nested
    // list/set that itself bottoms out at string/number composes into a
    // proper nested array type (e.g. `list(list(string))` -> `string[][]`),
    // with the whole-collection token additionally accepted alongside it.
    return {
      tsType: `${plainElement.tsType}[] | cdktn.IResolvable`,
      docstringType: `${label} Array<${plainElement.docstringType}>`,
      acceptsResolvableAlready: true,
    };
  }

  // map/object/dynamic element, or a nested collection that doesn't itself
  // reduce to string/number: no jsii-safe array-of-X type exists - widen
  // the whole parameter to `any[]`. Unlike a bare `any` parameter, plain
  // `any[]` does NOT structurally accept a whole-collection
  // `cdktn.IResolvable` token, so the union is required here (this is
  // stricter than `MapAttributeTypeModel`/`ListAttributeTypeModel` have to
  // be, since those only ever fall back to `any[] | cdktn.IResolvable` via
  // the same "not simple" branch above, which already grants it). Keep the
  // docstring honest about the real element shape rather than just saying
  // `any`.
  const elementDescription = mapParameterType(element).docstringType;
  return {
    tsType: "any[] | cdktn.IResolvable",
    docstringType: `${label} Array<${elementDescription}>`,
    acceptsResolvableAlready: true,
  };
}

/**
 * Maps a `map` parameter to its jsii-safe shape - mirrors
 * `MapAttributeTypeModel.inputTypeDefinition`. Only the `bool`-element case
 * is reachable from real provider schemas today (`string`/`number` element
 * maps stay a plain, non-union record; nested/complex map elements aren't
 * emitted for provider functions - see the `object` fallback in
 * `mapParameterType`), but the shape is kept branch-for-branch aligned with
 * the model it mirrors rather than collapsed.
 */
function mapMapParameterType(element: AttributeType): MappedParameterType {
  if (element === "string") {
    return {
      tsType: "{ [key: string]: string }",
      docstringType: "{ [key: string]: string }",
      acceptsResolvableAlready: false,
    };
  }
  if (element === "number") {
    return {
      tsType: "{ [key: string]: number }",
      docstringType: "{ [key: string]: number }",
      acceptsResolvableAlready: false,
    };
  }
  if (element === "bool") {
    // Mirrors the `elementType.storedClassType === "boolean"` branch: map
    // of booleans has PER-ENTRY token support, but the whole map itself is
    // not additionally unioned with `cdktn.IResolvable` (unlike the list/set
    // case) - matching `MapAttributeTypeModel.inputTypeDefinition` exactly.
    return {
      tsType: "{ [key: string]: (boolean | cdktn.IResolvable) }",
      docstringType: "{ [key: string]: (boolean | IResolvable) }",
      acceptsResolvableAlready: false,
    };
  }
  // map/object/dynamic element: no structural input helper exists here -
  // stays `any`, which (being `any`) already accepts a whole-map
  // `cdktn.IResolvable` token too.
  return {
    tsType: "any",
    docstringType: "any",
    acceptsResolvableAlready: true,
  };
}

/**
 * Maps a provider function parameter's declared Terraform type to a
 * jsii-safe TypeScript parameter type, recursively for collection types.
 *
 * Unlike return types, jsii allows unions in *parameter* position, so
 * `bool` is typed `boolean | cdktn.IResolvable` (mirroring
 * `SimpleAttributeTypeModel.inputTypeDefinition`'s input-side convention) -
 * this both accepts a real boolean and still accepts a token in place of
 * one. `dynamic` has no structural typing and stays `any` (which already
 * accepts anything, including a token); `object` (structural input helpers
 * are deferred to a follow-up issue) stays `any` too.
 *
 * `list`/`set` and `map` delegate to `mapListOrSetParameterType`/
 * `mapMapParameterType`, which mirror `ListAttributeTypeModel`/
 * `SetAttributeTypeModel`/`MapAttributeTypeModel.inputTypeDefinition`
 * branch for branch (see `attribute-type-model.ts`) - the same
 * whole-collection-token conventions already used for resource inputs.
 */
function mapParameterType(type: AttributeType): MappedParameterType {
  if (type === "string") {
    return {
      tsType: "string",
      docstringType: "string",
      acceptsResolvableAlready: false,
    };
  }
  if (type === "number") {
    return {
      tsType: "number",
      docstringType: "number",
      acceptsResolvableAlready: false,
    };
  }
  if (type === "bool") {
    return {
      tsType: "boolean | cdktn.IResolvable",
      docstringType: "boolean | IResolvable",
      acceptsResolvableAlready: true,
    };
  }
  if (type === "dynamic") {
    return {
      tsType: "any",
      docstringType: "any",
      acceptsResolvableAlready: true,
    };
  }

  if (Array.isArray(type) && (type[0] === "list" || type[0] === "set")) {
    return mapListOrSetParameterType(type[0], type[1]);
  }

  if (Array.isArray(type) && type[0] === "map") {
    return mapMapParameterType(type[1]);
  }

  // object: structural input helpers are deferred to a follow-up issue.
  return {
    tsType: "any",
    docstringType: "object",
    acceptsResolvableAlready: true,
  };
}

function buildParameterModel(
  parameter: FunctionParameter,
  fallbackName: string,
): InternalParameterModel {
  const terraformName = parameter.name ?? fallbackName;
  const { tsType, docstringType, acceptsResolvableAlready } = mapParameterType(
    parameter.type,
  );
  return {
    terraformName,
    name: sanitizeParameterName(terraformName),
    tsType,
    docstringType,
    description: parameter.description,
    acceptsResolvableAlready,
  };
}

/**
 * Widens a mapped type's `tsType`/`docstringType` to also accept an
 * explicit `cdktn.Token.nullValue()` in this position - unless
 * `acceptsResolvableAlready` says it already does (e.g. a `bool` parameter
 * is already `boolean | cdktn.IResolvable`, so nullability adds nothing to
 * the type itself, only to the docstring note appended by the caller).
 */
function withNullableResolvableUnion(
  model: Pick<
    InternalParameterModel,
    "tsType" | "docstringType" | "acceptsResolvableAlready"
  >,
): { tsType: string; docstringType: string } {
  if (model.acceptsResolvableAlready) {
    return { tsType: model.tsType, docstringType: model.docstringType };
  }
  return {
    tsType: `${model.tsType} | cdktn.IResolvable`,
    docstringType: `${model.docstringType} | IResolvable`,
  };
}

/**
 * Applies `is_nullable` trailing-compatibility rules across a function's
 * fixed (non-variadic) parameter list. This needs the whole list in view
 * (see `buildFunctionModel`), since whether a nullable parameter can become
 * jsii-optional depends on every parameter *after* it too:
 *
 * - A nullable parameter where it and every later fixed parameter are also
 *   nullable becomes jsii-optional (`name?: T`): omitting it in TypeScript
 *   leaves `undefined` in the invoke args array, which `FunctionCall`
 *   already renders as the Terraform `null` keyword. It additionally gains
 *   the `| cdktn.IResolvable` union (see `withNullableResolvableUnion`), so
 *   a caller who does supply the argument can pass
 *   `cdktn.Token.nullValue()` for an explicit Terraform `null` without
 *   omitting the parameter.
 * - A nullable parameter followed by a required one keeps its position
 *   (jsii can't express "optional but not trailing"), and instead gains the
 *   same `| cdktn.IResolvable` union so a caller can still pass an explicit
 *   `cdktn.Token.nullValue()` (an `IResolvable` resolving to `null` - see
 *   `Token.nullValue()`/`Token.asAny()`) in that fixed position; this
 *   replaces the previous blanket widening to `any`, which accepted the
 *   real type too but gave up all type safety to do it.
 *
 * Both cases document the real mechanism in the docstring rather than
 * implying the plain TypeScript `null` literal is accepted: the trailing
 * case can also just be omitted, the mid-position case can't be omitted at
 * all (jsii can't express "optional but not trailing").
 */
function applyNullability(
  parameters: FunctionParameter[],
  models: InternalParameterModel[],
): InternalParameterModel[] {
  const trailingCompatible = new Array(parameters.length).fill(false);
  let allNullableSoFar = true;
  for (let i = parameters.length - 1; i >= 0; i--) {
    allNullableSoFar = allNullableSoFar && parameters[i].is_nullable === true;
    trailingCompatible[i] = allNullableSoFar;
  }

  return models.map((model, index) => {
    const parameter = parameters[index];
    if (!parameter.is_nullable) return model;

    const { tsType, docstringType } = withNullableResolvableUnion(model);

    if (trailingCompatible[index]) {
      return {
        ...model,
        optional: true,
        tsType,
        docstringType: `${docstringType} - omit or pass cdktn.Token.nullValue() to render the Terraform null keyword`,
      };
    }

    return {
      ...model,
      tsType,
      docstringType: `${docstringType} - pass cdktn.Token.nullValue() for an explicit null`,
    };
  });
}

/**
 * Maps a provider function's declared return type to the jsii-safe
 * TypeScript return type, the `@returns` JSDoc type, and the expression
 * that unwraps the `TerraformProviderFunction.invoke(...)` `IResolvable`
 * into it.
 *
 * jsii return positions can't use the `T | cdktn.IResolvable` union that
 * parameters can (see `mapParameterType`), so every shape that can't be
 * losslessly unwrapped through an `asXxx` Token helper falls back to the
 * plain `cdktn.IResolvable` produced by `invoke()` itself, unwrapped.
 * Provider functions frequently return objects (e.g. every function in the
 * `time` provider), so - unlike built-in `Fn.*` functions - the object case
 * is a primary path, not an error: it is treated the same as
 * `dynamic`/a `list`/`set` of anything other than `string`/`number` (no
 * `asAnyList` Token helper exists), and returned as the RAW `invoke()`
 * result. `map` returns, unlike those, DO have a full set of typed Token
 * helpers (`asStringMap`/`asNumberMap`/`asBooleanMap`/`asAnyMap`), so every
 * `map` shape gets an actual typed record return instead of falling back to
 * `cdktn.IResolvable`.
 *
 * Whenever the declared return type IS `cdktn.IResolvable` (not `any`):
 * unlike `helpers.ts` `asAny`, this must NOT go through
 * `cdktn.Token.asString(...)` - `Token.asString()` produces an encoded
 * string token that `Tokenization.isResolvable()` does not recognize, so
 * generated struct setters (e.g. an `OutputReference` `internalValue`) treat
 * it as a plain object with no known keys and the attribute silently
 * vanishes from synth output. The raw `IResolvable` from `invoke()` IS
 * recognized by `Tokenization.isResolvable()` and resolves correctly.
 * Declaring it as `cdktn.IResolvable` instead of `any` also gives callers
 * real type safety: `any` let a caller write `result.hours` on a token with
 * no compile-time feedback, silently producing `undefined` at runtime;
 * `IResolvable` has no such property and forces the caller through
 * `cdktn.Token`/the provider's struct types instead. `invoke()` already
 * returns `IResolvable`, so no cast is needed to return it as
 * `cdktn.IResolvable`.
 */
function mapReturnType(returnType: AttributeType): {
  tsType: string;
  docstringType: string;
  wrapReturn: (invokeExpression: string) => string;
} {
  if (returnType === "string") {
    return {
      tsType: "string",
      docstringType: "string",
      wrapReturn: (expr) => `cdktn.Token.asString(${expr})`,
    };
  }
  if (returnType === "number") {
    return {
      tsType: "number",
      docstringType: "number",
      wrapReturn: (expr) => `cdktn.Token.asNumber(${expr})`,
    };
  }
  if (returnType === "bool") {
    // Booleans can't be represented as tokens (see helpers.ts asBoolean):
    // return the IResolvable produced by invoke() unwrapped. The docstring
    // still documents the real conceptual shape.
    return {
      tsType: "cdktn.IResolvable",
      docstringType: "boolean | IResolvable",
      wrapReturn: (expr) => expr,
    };
  }
  if (returnType === "dynamic") {
    return {
      tsType: "cdktn.IResolvable",
      docstringType: "any",
      wrapReturn: (expr) => expr,
    };
  }
  if (
    Array.isArray(returnType) &&
    (returnType[0] === "list" || returnType[0] === "set")
  ) {
    const label = returnType[0] === "set" ? "[set]" : "[list]";
    const element = returnType[1];
    if (element === "string") {
      return {
        tsType: "string[]",
        docstringType: `${label} Array<string>`,
        wrapReturn: (expr) => `cdktn.Token.asList(${expr})`,
      };
    }
    if (element === "number") {
      return {
        tsType: "number[]",
        docstringType: `${label} Array<number>`,
        wrapReturn: (expr) => `cdktn.Token.asNumberList(${expr})`,
      };
    }
    // list/set of anything else: there is no `asAnyList` Token helper -
    // fall back to the raw IResolvable, same reasoning as dynamic/object
    // below, but keep the docstring honest about the real element shape
    // (reusing mapParameterType purely for its descriptive docstringType -
    // its tsType/acceptsResolvableAlready are irrelevant here).
    return {
      tsType: "cdktn.IResolvable",
      docstringType: `${label} Array<${mapParameterType(element).docstringType}>`,
      wrapReturn: (expr) => expr,
    };
  }
  if (Array.isArray(returnType) && returnType[0] === "map") {
    // Unlike list/set and object/dynamic, every `map` shape has a matching
    // typed Token helper (see token.ts), so it gets a real typed record
    // return instead of falling back to the raw IResolvable.
    const element = returnType[1];
    if (element === "string") {
      return {
        tsType: "{ [key: string]: string }",
        docstringType: "{ [key: string]: string }",
        wrapReturn: (expr) => `cdktn.Token.asStringMap(${expr})`,
      };
    }
    if (element === "number") {
      return {
        tsType: "{ [key: string]: number }",
        docstringType: "{ [key: string]: number }",
        wrapReturn: (expr) => `cdktn.Token.asNumberMap(${expr})`,
      };
    }
    if (element === "bool") {
      // Token.asBooleanMap's declared return type is `{ [key: string]:
      // boolean }` (see token.ts) - used verbatim, not unioned with
      // IResolvable: the map's individual entries are plain booleans once
      // unwrapped by the helper.
      return {
        tsType: "{ [key: string]: boolean }",
        docstringType: "{ [key: string]: boolean }",
        wrapReturn: (expr) => `cdktn.Token.asBooleanMap(${expr})`,
      };
    }
    // map of anything else (object/dynamic/nested collection): asAnyMap
    // still gives a typed (if loosely-typed) record rather than falling
    // back to the raw IResolvable.
    return {
      tsType: "{ [key: string]: any }",
      docstringType: "{ [key: string]: any }",
      wrapReturn: (expr) => `cdktn.Token.asAnyMap(${expr})`,
    };
  }
  // object: no structural typing for arbitrary provider function results -
  // declared as `cdktn.IResolvable`, and returned as the raw `IResolvable`
  // from invoke() (NOT wrapped in `cdktn.Token.asString(...)`, which would
  // make the result unrecognizable to `Tokenization.isResolvable()`
  // downstream - see the mapReturnType docstring above).
  return {
    tsType: "cdktn.IResolvable",
    docstringType: "object",
    wrapReturn: (expr) => expr,
  };
}

function buildFunctionModel(
  terraformName: string,
  signature: FunctionSignature,
): ProviderFunctionModel {
  const {
    tsType: returnTsType,
    docstringType: returnDocstringType,
    wrapReturn,
  } = mapReturnType(signature.return_type);

  const rawParameters = signature.parameters ?? [];
  const parameters = applyNullability(
    rawParameters,
    rawParameters.map((parameter, index) =>
      buildParameterModel(parameter, `arg${index}`),
    ),
  );

  let variadicParameter: InternalParameterModel | undefined;
  if (signature.variadic_parameter) {
    const elementModel = buildParameterModel(
      signature.variadic_parameter,
      "values",
    );
    if (signature.variadic_parameter.is_nullable) {
      // A nullable variadic parameter: jsii can't express "each individual
      // argument may independently be null" on the generated `values:
      // Array<T>` array parameter (it's an ordinary array parameter, not a
      // true rest/spread parameter - only the invoke() call site spreads
      // it), so every element's type instead widens to also accept an
      // explicit `cdktn.Token.nullValue()`, the same way a fixed nullable
      // parameter does (see `withNullableResolvableUnion`); the docstring
      // keeps the honest per-element type plus that guidance.
      const { tsType, docstringType } =
        withNullableResolvableUnion(elementModel);
      variadicParameter = {
        ...elementModel,
        tsType,
        docstringType: `Array<${docstringType}> - pass cdktn.Token.nullValue() for an explicit null`,
      };
    } else {
      // Non-nullable: the docstring wraps the element's docstring type in
      // `Array<...>` here (rather than in the emitter), so every parameter
      // - fixed or variadic - can share one `@param {docstringType}`
      // emission path.
      variadicParameter = {
        ...elementModel,
        docstringType: `Array<${elementModel.docstringType}>`,
      };
    }
  }

  return {
    terraformName,
    methodName: sanitizeMethodName(terraformName),
    description: signature.description,
    summary: signature.summary,
    deprecationMessage: signature.deprecation_message,
    returnTsType,
    returnDocstringType,
    wrapReturn,
    parameters,
    variadicParameter,
  };
}

/**
 * Throws if two functions in the same provider sanitize to the same
 * generated method name. Terraform function names are unique, but
 * `sanitizeMethodName` (camelCasing, `length` -> `lengthOf`) is not
 * necessarily injective, so a real - if unlikely - provider schema could
 * still produce a duplicate method. Generation is aborted rather than
 * silently emitting one method that shadows the other.
 */
function assertNoMethodNameCollisions(
  providerName: string,
  functions: ProviderFunctionModel[],
): void {
  const seenBy = new Map<string, string>(); // methodName -> terraformName

  for (const fn of functions) {
    const existingTerraformName = seenBy.get(fn.methodName);
    if (existingTerraformName !== undefined) {
      throw new Error(
        `Provider "${providerName}" declares two provider-defined functions, ` +
          `"${existingTerraformName}" and "${fn.terraformName}", that both ` +
          `sanitize to the generated method name "${fn.methodName}". ` +
          `Generation aborted to avoid silently overwriting one method with ` +
          `the other - please report this as an issue.`,
      );
    }
    seenBy.set(fn.methodName, fn.terraformName);
  }
}

/**
 * Throws if a function's sanitized `methodName` lands on a member name
 * `ProviderFunctionsEmitter` already puts on every wrapper class (see
 * `RESERVED_WRAPPER_MEMBER_NAMES`). Unlike `assertNoMethodNameCollisions`,
 * which only catches two *functions* colliding with each other, this catches
 * a single function colliding with the wrapper class itself - e.g. a
 * Terraform function literally named "constructor", or "provider_local_name"
 * camelCasing to "providerLocalName".
 *
 * This intentionally does NOT also check sanitized *parameter* names against
 * "providerLocalName": parameters are declared in the generated method's own
 * scope, not the class's, so a parameter named `providerLocalName` shadows
 * the class field within that method body without colliding with it (valid,
 * if confusing, TypeScript) - there is nothing to abort generation over.
 */
function assertNoReservedWrapperMemberCollisions(
  providerName: string,
  functions: ProviderFunctionModel[],
): void {
  for (const fn of functions) {
    if (RESERVED_WRAPPER_MEMBER_NAMES.has(fn.methodName)) {
      throw new Error(
        `Provider "${providerName}" declares a provider-defined function ` +
          `"${fn.terraformName}" that sanitizes to the generated method name ` +
          `"${fn.methodName}", which collides with a member that ` +
          `ProviderFunctionsEmitter already puts on every ` +
          `"<Provider>ProviderFunctions" wrapper class (the class ` +
          `constructor, or its "providerLocalName" field). Generation ` +
          `aborted to avoid emitting invalid TypeScript or silently ` +
          `shadowing that member - please report this as an issue.`,
      );
    }
  }
}

/**
 * Throws if two parameters of the same function (including the variadic
 * parameter) sanitize to the same generated parameter name, for the same
 * reason as `assertNoMethodNameCollisions` above but at the parameter level.
 */
function assertNoParameterNameCollisions(
  providerName: string,
  fn: ProviderFunctionModel,
): void {
  const seenBy = new Map<string, string>(); // sanitized name -> terraformName
  const allParameters = fn.variadicParameter
    ? [...fn.parameters, fn.variadicParameter]
    : fn.parameters;

  for (const param of allParameters) {
    const existingTerraformName = seenBy.get(param.name);
    if (existingTerraformName !== undefined) {
      throw new Error(
        `Provider "${providerName}" function "${fn.terraformName}" declares ` +
          `two parameters, "${existingTerraformName}" and ` +
          `"${param.terraformName}", that both sanitize to the generated ` +
          `parameter name "${param.name}". Generation aborted to avoid ` +
          `silently dropping one parameter - please report this as an issue.`,
      );
    }
    seenBy.set(param.name, param.terraformName);
  }
}

/**
 * Throws if the provider's own config schema declares an attribute whose
 * generated property name (see `AttributeModel.name` /
 * `escapeAttributeName`) is exactly "functions", while the provider also
 * declares provider-defined functions. That combination would collide with
 * the memoized `functions` getter `ResourceEmitter` emits on the provider
 * class (see `resource-emitter.ts`'s `emitFunctionsGetter`) - one would
 * silently shadow the other. Same loud-failure convention as
 * `assertNoMethodNameCollisions`/`assertNoParameterNameCollisions` above:
 * generation is aborted rather than silently picking a winner.
 */
export function assertNoFunctionsGetterCollision(
  providerName: string,
  attributeNames: string[],
): void {
  if (attributeNames.includes("functions")) {
    throw new Error(
      `Provider "${providerName}" declares provider-defined functions and its ` +
        `own config schema also has an attribute that generates the property ` +
        `name "functions" on the provider class. This collides with the ` +
        `generated "functions" getter used to invoke provider-defined ` +
        `functions. Generation aborted to avoid silently shadowing one with ` +
        `the other - please report this as an issue.`,
    );
  }
}

/**
 * Builds the model for a provider's `provider-functions/index.ts` file from
 * its provider schema `functions` map. Returns `undefined` when the provider
 * declares no functions - callers should skip emitting the file entirely.
 */
export function buildProviderFunctionsModel(
  providerName: string,
  functions: { [name: string]: FunctionSignature } | undefined,
): ProviderFunctionsModel | undefined {
  const entries = Object.entries(functions ?? {});
  if (entries.length === 0) return undefined;

  const mappedFunctions = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, signature]) => buildFunctionModel(name, signature));

  assertNoMethodNameCollisions(providerName, mappedFunctions);
  assertNoReservedWrapperMemberCollisions(providerName, mappedFunctions);
  for (const fn of mappedFunctions) {
    assertNoParameterNameCollisions(providerName, fn);
  }

  return {
    providerName,
    className: `${toPascalCase(providerName)}ProviderFunctions`,
    functions: mappedFunctions,
  };
}
