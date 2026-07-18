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
   * Never set on the variadic parameter: rest parameters can't be `?`.
   */
  readonly optional?: boolean;
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

/**
 * Maps a provider function parameter's declared Terraform type to a
 * jsii-safe TypeScript parameter type, recursively for collection types.
 *
 * Unlike return types, jsii allows unions in *parameter* position, so
 * `bool` is typed `boolean | cdktn.IResolvable` (mirroring
 * `SimpleAttributeTypeModel.inputTypeDefinition`'s input-side convention) -
 * this both accepts a real boolean and still accepts a token in place of
 * one. `dynamic`, `object`, and non-primitive `map` values have no
 * structural typing here (structural input helpers for `object` are
 * deferred to a follow-up issue) and stay `any`.
 *
 * `list`/`set` recurse on their element type: primitive elements (string,
 * number, bool) compose into a proper array type; a nested list/set of a
 * representable element type composes naturally too (e.g.
 * `list(list(string))` -> `string[][]`). Anything that isn't representable
 * as an array element in jsii (map, object, dynamic, or a nested collection
 * that itself bottoms out at `any`) widens the *whole* parameter to
 * `any[]`, but the docstring keeps describing the real element shape (e.g.
 * `Array<object>`) rather than lying about it.
 */
function mapParameterType(type: AttributeType): {
  tsType: string;
  docstringType: string;
} {
  if (type === "string") return { tsType: "string", docstringType: "string" };
  if (type === "number") return { tsType: "number", docstringType: "number" };
  if (type === "bool") {
    return {
      tsType: "boolean | cdktn.IResolvable",
      docstringType: "boolean | IResolvable",
    };
  }
  if (type === "dynamic") return { tsType: "any", docstringType: "any" };

  if (Array.isArray(type) && (type[0] === "list" || type[0] === "set")) {
    const element = type[1];

    if (element === "string") {
      return { tsType: "string[]", docstringType: "Array<string>" };
    }
    if (element === "number") {
      return { tsType: "number[]", docstringType: "Array<number>" };
    }
    if (element === "bool") {
      return {
        tsType: "Array<boolean | cdktn.IResolvable>",
        docstringType: "Array<boolean | IResolvable>",
      };
    }
    if (
      Array.isArray(element) &&
      (element[0] === "list" || element[0] === "set")
    ) {
      // Nested list/set: recurse and compose. If the inner element type
      // is itself a union (bool's `boolean | cdktn.IResolvable`), a plain
      // trailing `[]` would bind to the wrong operand
      // (`boolean | cdktn.IResolvable[]` reads as `boolean | (IResolvable[])`),
      // so use the generic `Array<T>` form in that case instead.
      const child = mapParameterType(element);
      return {
        tsType: child.tsType.includes("|")
          ? `Array<${child.tsType}>`
          : `${child.tsType}[]`,
        docstringType: `Array<${child.docstringType}>`,
      };
    }
    // map/object/dynamic element: no jsii-safe array-of-X type exists -
    // widen the whole parameter to `any[]`, but keep the docstring honest
    // about the real element shape.
    const child = mapParameterType(element);
    return {
      tsType: "any[]",
      docstringType: `Array<${child.docstringType}>`,
    };
  }

  if (Array.isArray(type) && type[0] === "map") {
    const element = type[1];
    if (element === "string") {
      return {
        tsType: "{ [key: string]: string }",
        docstringType: "{ [key: string]: string }",
      };
    }
    if (element === "number") {
      return {
        tsType: "{ [key: string]: number }",
        docstringType: "{ [key: string]: number }",
      };
    }
    if (element === "bool") {
      return {
        tsType: "{ [key: string]: (boolean | cdktn.IResolvable) }",
        docstringType: "{ [key: string]: (boolean | IResolvable) }",
      };
    }
    return { tsType: "any", docstringType: "any" };
  }

  // object: structural input helpers are deferred to a follow-up issue.
  return { tsType: "any", docstringType: "object" };
}

function buildParameterModel(
  parameter: FunctionParameter,
  fallbackName: string,
): ProviderFunctionParameterModel {
  const terraformName = parameter.name ?? fallbackName;
  const { tsType, docstringType } = mapParameterType(parameter.type);
  return {
    terraformName,
    name: sanitizeParameterName(terraformName),
    tsType,
    docstringType,
    description: parameter.description,
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
 *   already renders as the Terraform `null` keyword.
 * - A nullable parameter followed by a required one keeps its position
 *   (jsii can't express "optional but not trailing"), but widens its type
 *   to `any` so a caller can still pass an explicit `null`.
 *
 * Both cases widen the docstring type to `T | null` to document the real
 * Terraform-side nullability regardless of what jsii can express.
 */
function applyNullability(
  parameters: FunctionParameter[],
  models: ProviderFunctionParameterModel[],
): ProviderFunctionParameterModel[] {
  const trailingCompatible = new Array(parameters.length).fill(false);
  let allNullableSoFar = true;
  for (let i = parameters.length - 1; i >= 0; i--) {
    allNullableSoFar = allNullableSoFar && parameters[i].is_nullable === true;
    trailingCompatible[i] = allNullableSoFar;
  }

  return models.map((model, index) => {
    const parameter = parameters[index];
    if (!parameter.is_nullable) return model;

    if (trailingCompatible[index]) {
      return {
        ...model,
        optional: true,
        docstringType: `${model.docstringType} | null`,
      };
    }

    return {
      ...model,
      tsType: "any",
      docstringType: `${model.docstringType} | null`,
    };
  });
}

/**
 * Maps a provider function's declared return type to the jsii-safe
 * TypeScript return type and the expression that unwraps the
 * `TerraformProviderFunction.invoke(...)` `IResolvable` into it.
 *
 * jsii return positions can't use the `T | cdktn.IResolvable` union that
 * parameters can (see `mapParameterType`), so every shape that can't be
 * losslessly unwrapped through an `asXxx` Token helper falls back to the
 * plain `cdktn.IResolvable` produced by `invoke()` itself, unwrapped.
 * Provider functions frequently return objects (e.g. every function in the
 * `time` provider), so - unlike built-in `Fn.*` functions - the object case
 * is a primary path, not an error: it is treated the same as
 * `dynamic`/`map`/a `list`/`set` of anything other than `string`/`number`
 * (no `asAnyList` Token helper exists), and returned as the RAW `invoke()`
 * result.
 *
 * The declared return type is `cdktn.IResolvable` (not `any`): unlike
 * `helpers.ts` `asAny`, this must NOT go through `cdktn.Token.asString(...)`
 * - `Token.asString()` produces an encoded string token that
 * `Tokenization.isResolvable()` does not recognize, so generated struct
 * setters (e.g. an `OutputReference` `internalValue`) treat it as a plain
 * object with no known keys and the attribute silently vanishes from synth
 * output. The raw `IResolvable` from `invoke()` IS recognized by
 * `Tokenization.isResolvable()` and resolves correctly. Declaring it as
 * `cdktn.IResolvable` instead of `any` also gives callers real type safety:
 * `any` let a caller write `result.hours` on a token with no compile-time
 * feedback, silently producing `undefined` at runtime; `IResolvable` has no
 * such property and forces the caller through `cdktn.Token`/the provider's
 * struct types instead. `invoke()` already returns `IResolvable`, so no
 * cast is needed to return it as `cdktn.IResolvable`.
 */
function mapReturnType(returnType: AttributeType): {
  tsType: string;
  wrapReturn: (invokeExpression: string) => string;
} {
  if (returnType === "string") {
    return {
      tsType: "string",
      wrapReturn: (expr) => `cdktn.Token.asString(${expr})`,
    };
  }
  if (returnType === "number") {
    return {
      tsType: "number",
      wrapReturn: (expr) => `cdktn.Token.asNumber(${expr})`,
    };
  }
  if (returnType === "bool") {
    // Booleans can't be represented as tokens (see helpers.ts asBoolean):
    // return the IResolvable produced by invoke() unwrapped.
    return {
      tsType: "cdktn.IResolvable",
      wrapReturn: (expr) => expr,
    };
  }
  if (
    Array.isArray(returnType) &&
    (returnType[0] === "list" || returnType[0] === "set")
  ) {
    const element = returnType[1];
    if (element === "string") {
      return {
        tsType: "string[]",
        wrapReturn: (expr) => `cdktn.Token.asList(${expr})`,
      };
    }
    if (element === "number") {
      return {
        tsType: "number[]",
        wrapReturn: (expr) => `cdktn.Token.asNumberList(${expr})`,
      };
    }
    // list/set of anything else: there is no `asAnyList` Token helper -
    // fall back to the raw IResolvable, same reasoning as
    // dynamic/map/object below.
    return {
      tsType: "cdktn.IResolvable",
      wrapReturn: (expr) => expr,
    };
  }
  // dynamic, map, object: no structural typing for arbitrary provider
  // function results - declared as `cdktn.IResolvable`, and returned as the
  // raw `IResolvable` from invoke() (NOT wrapped in `cdktn.Token.asString(...)`,
  // which would make the result unrecognizable to
  // `Tokenization.isResolvable()` downstream - see the mapReturnType
  // docstring above).
  return {
    tsType: "cdktn.IResolvable",
    wrapReturn: (expr) => expr,
  };
}

function buildFunctionModel(
  terraformName: string,
  signature: FunctionSignature,
): ProviderFunctionModel {
  const { tsType: returnTsType, wrapReturn } = mapReturnType(
    signature.return_type,
  );

  const rawParameters = signature.parameters ?? [];
  const parameters = applyNullability(
    rawParameters,
    rawParameters.map((parameter, index) =>
      buildParameterModel(parameter, `arg${index}`),
    ),
  );

  let variadicParameter = signature.variadic_parameter
    ? buildParameterModel(signature.variadic_parameter, "values")
    : undefined;
  if (variadicParameter && signature.variadic_parameter?.is_nullable) {
    // A nullable variadic parameter: jsii can't express "each individual
    // argument may independently be null" on a rest parameter, so the
    // element type widens to `any` (signature becomes `values: any[]`);
    // the docstring keeps the honest per-element type.
    variadicParameter = {
      ...variadicParameter,
      tsType: "any",
      docstringType: `${variadicParameter.docstringType} | null`,
    };
  }

  return {
    terraformName,
    methodName: sanitizeMethodName(terraformName),
    description: signature.description,
    summary: signature.summary,
    deprecationMessage: signature.deprecation_message,
    returnTsType,
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
  for (const fn of mappedFunctions) {
    assertNoParameterNameCollisions(providerName, fn);
  }

  return {
    providerName,
    className: `${toPascalCase(providerName)}ProviderFunctions`,
    functions: mappedFunctions,
  };
}
