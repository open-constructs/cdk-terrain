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
// jsii target languages; mirrors tools/generate-function-bindings mapParameter.
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
 * jsii-safe TypeScript parameter type. Booleans can't be represented as
 * tokens (see helpers.ts asBoolean), so they're typed `any` to still accept
 * tokens; dynamic/map/object parameters are also `any` (no structural typing
 * for arbitrary provider function args).
 */
function mapParameterType(type: AttributeType): {
  tsType: string;
  docstringType: string;
} {
  if (type === "string") return { tsType: "string", docstringType: "string" };
  if (type === "number") return { tsType: "number", docstringType: "number" };
  if (type === "bool") return { tsType: "any", docstringType: "any" };
  if (type === "dynamic") return { tsType: "any", docstringType: "any" };
  if (Array.isArray(type) && (type[0] === "list" || type[0] === "set")) {
    return { tsType: "any[]", docstringType: "Array<any>" };
  }
  if (Array.isArray(type) && (type[0] === "map" || type[0] === "object")) {
    return { tsType: "any", docstringType: "any" };
  }
  return { tsType: "any", docstringType: "any" };
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
 * Maps a provider function's declared return type to the jsii-safe
 * TypeScript return type and the expression that unwraps the
 * `TerraformProviderFunction.invoke(...)` `IResolvable` into it. Provider
 * functions frequently return objects (e.g. every function in the `time`
 * provider), so - unlike built-in `Fn.*` functions - the object case is a
 * primary path, not an error: it is treated the same as `dynamic`/`map`,
 * declared `any` and returned as the RAW `invoke()` result (an
 * `IResolvable`), unwrapped. Unlike `helpers.ts` `asAny`, this must NOT go
 * through `cdktn.Token.asString(...)`: `Token.asString()` produces an
 * encoded string token that `Tokenization.isResolvable()` does not
 * recognize, so generated struct setters (e.g. an `OutputReference`
 * `internalValue`) treat it as a plain object with no known keys and the
 * attribute silently vanishes from synth output. The raw `IResolvable` from
 * `invoke()` IS recognized by `Tokenization.isResolvable()` and resolves
 * correctly; jsii can still hand it back as `any` without a cast because
 * `IResolvable` is assignable to `any`.
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
    return {
      tsType: "string[]",
      wrapReturn: (expr) => `cdktn.Token.asList(${expr})`,
    };
  }
  // dynamic, map, object: no structural typing for arbitrary provider
  // function results - declared as `any`, but returned as the raw
  // `IResolvable` from invoke() (NOT wrapped in `cdktn.Token.asString(...)`,
  // which would make the result unrecognizable to
  // `Tokenization.isResolvable()` downstream - see the mapReturnType
  // docstring above). `IResolvable` is assignable to `any`, so no cast is
  // needed either.
  return {
    tsType: "any",
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

  return {
    terraformName,
    methodName: sanitizeMethodName(terraformName),
    description: signature.description,
    summary: signature.summary,
    returnTsType,
    wrapReturn,
    parameters: (signature.parameters ?? []).map((parameter, index) =>
      buildParameterModel(parameter, `arg${index}`),
    ),
    variadicParameter: signature.variadic_parameter
      ? buildParameterModel(signature.variadic_parameter, "values")
      : undefined,
  };
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

  return {
    providerName,
    className: `${toPascalCase(providerName)}ProviderFunctions`,
    functions: entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, signature]) => buildFunctionModel(name, signature)),
  };
}
