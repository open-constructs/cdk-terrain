// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Tokenization, Token } from "../tokens/token";
import { call } from "../tfExpression";
import { IResolvable } from "../tokens/resolvable";
import { TokenString, extractTokenDouble } from "../tokens/private/encoding";
import {
  functionArgumentValidationFailure,
  functionReceivedWrongNumberOfArgs,
  listElementIsOfWrongType,
  valueContainsUnescapedQuotes,
  valueIsInvalidNumberOrToken,
  valueIsInvalidStringOrToken,
} from "../errors";

type TFValue<T> = { variadic?: boolean; value: T };
type TFValueValidator<T> = (value: T) => TFValue<T>;

type ExecutableTfFunction = (...args: any[]) => IResolvable;

/**
 * Determines if given str has unescaped double quotes
 * @param str String to test
 * @returns Boolean
 */
function hasUnescapedDoubleQuotes(str: string) {
  return /(^|[^\\])([\\]{2})*"/.test(str);
}

// Validators
/**
 * Validator that accepts any value
 * @param value Value to validate
 * @returns The wrapped value
 */
export function anyValue<T>(value: T): TFValue<T> {
  return { value };
}

/**
 * Validator for map values; accepts any value without checking it
 * @param value Value to validate
 * @returns The wrapped value
 */
export function mapValue<T>(value: T): TFValue<T> {
  return { value };
}

/**
 * Validator that accepts a string or a token
 * @param value Value to validate
 * @returns The wrapped value
 * @throws If the value is neither a string nor a token, or is a string containing unescaped double quotes
 */
export function stringValue<T extends string>(value: T): TFValue<T> {
  if (typeof value !== "string" && !Tokenization.isResolvable(value)) {
    throw valueIsInvalidStringOrToken(value);
  }

  if (typeof value === "string" && hasUnescapedDoubleQuotes(value)) {
    throw valueContainsUnescapedQuotes(value);
  }

  return { value };
}

/**
 * Validator that accepts a number or a token
 * @param value Value to validate
 * @returns The wrapped value
 * @throws If the value is neither a number nor a token
 */
export function numericValue<T>(value: T): TFValue<T> {
  if (typeof value !== "number" && !Tokenization.isResolvable(value)) {
    throw valueIsInvalidNumberOrToken(value as string);
  }
  return { value };
}

/**
 * Creates a validator for lists whose elements are checked with the given element validator. Tokens and non-array
 * values pass through unchanged; `null`/`undefined` elements are dropped, token elements are kept as-is and plain
 * string elements are wrapped in double quotes.
 * @param type Validator applied to each non-token element
 * @returns A list validator that throws if an element fails the element validator
 */
export function listOf<T>(type: TFValueValidator<T>): TFValueValidator<T[]> {
  return (value: any) => {
    if (Tokenization.isResolvable(value)) {
      return { value };
    }

    if (!Array.isArray(value)) {
      //   throw new Error(`${value} is not a valid list`);
      return { value };
    }

    return {
      value: value
        .filter((item) => item !== undefined && item !== null)
        .map((item, i) => {
          if (Tokenization.isResolvable(item)) {
            return item;
          }

          if (TokenString.forListToken(item).test()) {
            return item;
          }

          if (extractTokenDouble(item, true) !== undefined) {
            return item;
          }

          if (TokenString.forMapToken(item).test()) {
            return item;
          }

          if (typeof item === "string") {
            const tokenList = Tokenization.reverseString(item);
            const numberOfTokens =
              tokenList.tokens.length + tokenList.intrinsic.length;
            if (numberOfTokens === 1 && tokenList.literals.length === 0) {
              return item;
            }
          }

          try {
            type(item);
            return typeof item === "string" ? `"${item}"` : item;
          } catch (error) {
            throw listElementIsOfWrongType(value, i, error);
          }
        }),
    };
  };
}

/**
 * Creates a validator for a variadic argument: validates the value as a list and marks it to be expanded into
 * separate arguments of the Terraform function call
 * @param type Validator applied to each element
 * @returns A validator for the variadic argument
 */
export function variadic<T>(type: TFValueValidator<T>): TFValueValidator<T[]> {
  return (value: any) => {
    // we use the list validator and set variadic to true in order to have it expanded in the args passed to the TF function
    return { value: listOf(type)(value).value, variadic: true };
  };
}

// Tokenization
/**
 * Converts a resolvable into a string token
 * @param value Resolvable to convert
 * @returns String token
 */
export function asString(value: IResolvable) {
  return Token.asString(value);
}

/**
 * Converts a resolvable into a number token
 * @param value Resolvable to convert
 * @returns Number token
 */
export function asNumber(value: IResolvable) {
  return Token.asNumber(value);
}

/**
 * Converts a resolvable into a string list token
 * @param value Resolvable to convert
 * @returns String list token
 */
export function asList(value: IResolvable) {
  return Token.asList(value);
}

/**
 * Converts a resolvable into a string map token
 * @param value Resolvable to convert
 * @returns String map token
 */
export function asStringMap(value: IResolvable) {
  return Token.asStringMap(value);
}

/**
 * Returns the resolvable unchanged, as booleans can not be represented as a token
 * @param value Resolvable to return
 * @returns The same resolvable
 */
export function asBoolean(value: IResolvable) {
  return value; // Booleans can not be represented as a token
}

/**
 * Converts a resolvable into a string token typed as `any`
 * @param value Resolvable to convert
 * @returns String token typed as `any`
 */
export function asAny(value: IResolvable) {
  // Ordinarily casting to any can cause issues, but
  // in this case it makes using functions a bit easier in TS
  // and doesn't really harm other languages.
  // Jsii has issues when returning the value directly,
  // so wrap as a string.
  return asString(value) as any;
}

/**
 * Creates a function that validates its arguments and returns a Terraform function call expression
 * @param name Name of the Terraform function
 * @param argValidators Validators for each positional argument
 * @returns A function returning the call expression; it throws if the number of arguments does not match the
 * validators or an argument fails validation
 */
export function terraformFunction(
  name: string,
  argValidators: TFValueValidator<any>[],
): ExecutableTfFunction {
  return function (...args: any[]) {
    if (args.length !== argValidators.length) {
      throw functionReceivedWrongNumberOfArgs(
        name,
        argValidators.length,
        args.length,
      );
    }
    return call(
      name,
      // We use flatMap now, since listOf() wraps everything in an extra array but variadic() does not
      // This enables us to have variadic pass multiple args into the call() from a single array
      args.reduce((carry, arg, i) => {
        try {
          const val = argValidators[i](arg);
          if (val.variadic) return [...carry, ...val.value];
          else return [...carry, val.value];
        } catch (error) {
          throw functionArgumentValidationFailure(i, name, error);
        }
      }, []),
    );
  };
}
