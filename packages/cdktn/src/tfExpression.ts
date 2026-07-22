// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { IResolvable, IResolveContext } from "./tokens/resolvable";
import { Intrinsic } from "./tokens/private/intrinsic";
import { Tokenization, Token } from "./tokens/token";
import { App } from "./app";
import { TerraformStack } from "./terraform-stack";
import { ITerraformDependable } from "./terraform-dependable";
import { Construct } from "constructs";

const TERRAFORM_IDENTIFIER_REGEX = /^[_a-zA-Z][_a-zA-Z0-9]*$/;

/**
 * Serializes an object key as a Terraform quoted-string literal:
 * `JSON.stringify` covers quotes, backslashes and control characters, and
 * `$${`/`%%{` are Terraform's own escapes for what would otherwise become
 * template interpolation/directive sequences inside the quoted string. The
 * pre-existing direct-object branches of `resolveExpressionPart` still
 * interpolate keys unescaped - tracked in
 * https://github.com/open-constructs/cdk-terrain/issues/350.
 */
function quotedStringKey(key: string): string {
  // Replacer functions, not replacement strings: in a replacement string
  // `$$` is itself an escape (for a literal `$`), so `"$${"` would emit
  // just `${` - silently undoing the escape this exists to produce.
  return JSON.stringify(key)
    .replace(/\$\{/g, () => "$${")
    .replace(/%\{/g, () => "%%{");
}

// eslint-disable-next-line jsdoc/require-jsdoc
class TFExpression extends Intrinsic implements IResolvable {
  protected resolveExpressionPart(context: IResolveContext, arg: any): string {
    const resolvedArg = context.resolve(arg);
    if (Tokenization.isResolvable(arg)) {
      // A resolvable arg (e.g. `cdktn.Token.nullValue()`, an IResolvable
      // wrapping `null` - see Token.nullValue()/Token.asAny()) can itself
      // resolve to `null`/`undefined`. Collapse that to the literal "null"
      // string too, for the exact same reason as the plain-null/undefined
      // branch further down: Array.prototype.join() (used by callers like
      // FunctionCall.resolve()) treats a `null`/`undefined` array ELEMENT as
      // an empty string, silently dropping the argument instead of
      // rendering the Terraform `null` keyword. Without this, only a
      // literal JS `null`/`undefined` argument rendered correctly - a
      // resolvable token that resolves to `null` (the only way to pass an
      // explicit `null` in a jsii-typed fixed position, since jsii can't
      // express a literal `null` parameter type) silently vanished instead.
      if (resolvedArg === null || resolvedArg === undefined) {
        return "null";
      }
      // A resolvable can itself resolve to a plain (unencoded) array/object
      // rather than an already-rendered string - e.g. a manually-constructed
      // whole-collection token like `cdktn.Token.asAny([true, false])`
      // (exactly the shape a jsii-typed `Array<boolean | cdktn.IResolvable>
      // | cdktn.IResolvable` provider-function parameter now accepts - see
      // provider-function-model.ts). Format it the same bracket/brace way
      // the plain array/object branches below do, recursing on
      // `resolvedArg`'s own elements (NOT `arg`'s - `arg` is the resolvable
      // wrapper itself, not indexable/keyable). Without this, the array
      // branch below is unreachable for a resolvable arg (this `if` already
      // returned), so the raw array/object fell straight through to the
      // plain `return resolvedArg` at the bottom - relying on the caller's
      // `Array.prototype.join()` (FunctionCall.resolve() et al.) to
      // stringify it, which drops an array's brackets/spacing (renders
      // `true,false` instead of `[true, false]`) and, for an object, would
      // produce the useless literal string `[object Object]`.
      if (Array.isArray(resolvedArg)) {
        return `[${resolvedArg
          .map((item) => this.resolveArg(context, item))
          .join(", ")}]`;
      }
      if (typeof resolvedArg === "object") {
        return `{${Object.keys(resolvedArg)
          .map(
            (key) =>
              `${quotedStringKey(key)} = ${this.resolveArg(context, resolvedArg[key])}`,
          )
          .join(", ")}}`;
      }
      return resolvedArg;
    }
    if (Array.isArray(resolvedArg)) {
      return `[${resolvedArg
        .map((_, index) => this.resolveArg(context, arg[index]))
        .join(", ")}]`;
    }

    if (typeof resolvedArg === "object" && resolvedArg !== null) {
      return `{${Object.keys(resolvedArg)
        .map((key) => `"${key}" = ${this.resolveArg(context, arg[key])}`)
        .join(", ")}}`;
    }

    // A literal `null`/`undefined` argument (e.g. a fixed-arity provider
    // function positional slot the caller intentionally left empty) must be
    // rendered as the Terraform `null` keyword. Without this, `resolvedArg`
    // stays `null`/`undefined` and Array.prototype.join() (used by callers
    // like FunctionCall.resolve()) silently collapses it to an empty string,
    // shifting/dropping the argument instead of rendering `null`.
    if (resolvedArg === null || resolvedArg === undefined) {
      return "null";
    }

    return resolvedArg;
  }

  protected resolveArg(context: IResolveContext, arg: any): string {
    const resolvedArg = context.resolve(arg);

    if (typeof arg === "string") {
      const str = this.resolveString(arg, resolvedArg);
      // When Token.asString() is used on an object, str will be the object and needs to be resolved differently
      // This happens for example in MapTerraformIterator#_getForEachExpression and can cause issues like #3540
      if (typeof str !== "string") {
        return this.resolveExpressionPart(context, str);
      }
      return str;
    }

    return this.resolveExpressionPart(context, arg);
  }

  /**
   * Escape string removes characters from the string that are not allowed in Terraform or JSON
   * It must only be used on non-token values
   */
  protected escapeString(str: string) {
    return str
      .replace(/\n/g, "\\n") // escape newlines
      .replace(/\${/g, "$$${"); // escape ${ to $${
  }

  private resolveString(str: string, resolvedArg: any) {
    const tokenList = Tokenization.reverseString(str);
    const numberOfTokens = tokenList.tokens.length + tokenList.intrinsic.length;

    // String literal
    if (numberOfTokens === 0) {
      return resolvedArg !== `"` &&
        resolvedArg.startsWith('"') &&
        resolvedArg.endsWith('"')
        ? this.escapeString(resolvedArg)
        : `"${this.escapeString(resolvedArg)}"`;
    }

    // Only a token reference
    if (
      tokenList.literals.length === 0 &&
      tokenList.escapes.length === 0 &&
      numberOfTokens === 1
    ) {
      return resolvedArg;
    }

    // String literal + token reference combination
    const joinResult = tokenList.join({
      join: (left, right) => {
        const leftTokens = Tokenization.reverse(left);
        const leftTokenList = Tokenization.reverseString(left);
        const rightTokens = Tokenization.reverse(right);

        const leftTokenCount =
          leftTokenList.intrinsic.length + leftTokenList.tokens.length;

        // if left is mixed, needs to be left alone (because it's a result of a previous join iteration)
        let leftValue = left;

        // if left is a string literal, then we need to escape it
        if (leftTokenList.literals.length === 1 && leftTokenCount === 0) {
          leftValue = this.escapeString(left);
        }

        // if left is only a token, needs to be wrapped as terraform expression
        if (leftTokenList.literals.length === 0 && leftTokenCount === 1) {
          leftValue = `\${${leftTokens[0]}}`;
        }

        const rightValue =
          rightTokens.length === 0
            ? this.escapeString(right)
            : `\${${rightTokens[0]}}`;

        return `${leftValue}${rightValue}`;
      },
    });

    return joinResult !== `"` &&
      joinResult.startsWith('"') &&
      joinResult.endsWith('"')
      ? joinResult
      : `"${joinResult}"`;
  }
}

// A string that represents an input value to be escaped
// eslint-disable-next-line jsdoc/require-jsdoc
class RawString extends TFExpression {
  constructor(private readonly str: string) {
    super(str);
  }

  public resolve(context: IResolveContext) {
    const qts = context.suppressBraces ? `"` : ``;
    return `${qts}${this.escapeString(this.str).replace(/\"/g, '\\"')}${qts}`; // eslint-disable-line no-useless-escape
  }

  public toString() {
    return this.str;
  }
}

// eslint-disable-next-line jsdoc/require-jsdoc
export function rawString(str: string): IResolvable {
  return new RawString(str);
}

// eslint-disable-next-line jsdoc/require-jsdoc
class Reference extends TFExpression {
  /**
   * A single reference could be used in multiple stacks,
   * e.g. if we expose the ref directly or as token on the stack.
   * We need to store the identifier for each stack,
   * so that the resolved identifier string matches the stack it's resolved in.
   */
  private crossStackIdentifier: Record<string, string> = {};
  constructor(
    private identifier: string,
    private originStack?: TerraformStack,
  ) {
    super(identifier);
  }

  public resolve(context: IResolveContext): string {
    // We check for cross stack references on preparation, setting a new identifier
    const resolutionStack = TerraformStack.of(context.scope);
    const stackName = resolutionStack.toString();
    const suppressBraces = context.suppressBraces;
    context.suppressBraces = true;

    if (context.preparing) {
      // Cross stack reference
      if (this.originStack && this.originStack !== resolutionStack) {
        const app = App.of(this.originStack);
        const csr = app.crossStackReference(
          this.originStack,
          resolutionStack,
          this.identifier,
        );

        this.crossStackIdentifier[stackName] = csr;
      }
    }

    // If this is a cross stack reference we will resolve to a reference within this stack.
    if (this.crossStackIdentifier[stackName]) {
      return suppressBraces
        ? this.crossStackIdentifier[stackName]
        : `\${${this.crossStackIdentifier[stackName]}}`;
    }

    return suppressBraces ? this.identifier : `\${${this.identifier}}`;
  }
}

// eslint-disable-next-line jsdoc/require-jsdoc
export function ref(identifier: string, stack?: TerraformStack): IResolvable {
  return new Reference(identifier, stack);
}

/**
 * marks the argument as being used in a terraform expression
 * @deprecated
 */
export function insideTfExpression(arg: any) {
  return arg;
}

// eslint-disable-next-line jsdoc/require-jsdoc
class PropertyAccess extends TFExpression {
  constructor(
    private target: Expression,
    private args: Expression[],
  ) {
    super({ target, args });
  }

  public resolve(context: IResolveContext): string {
    const suppressBraces = context.suppressBraces;
    context.suppressBraces = true;

    const serializedArgs = this.args
      .map((arg) => {
        if (arg === `*`) {
          return "[*]";
        }

        const a = this.resolveArg(context, arg);
        const isPlainString =
          typeof arg === "string" && TERRAFORM_IDENTIFIER_REGEX.test(arg);
        const isPlainNumber =
          typeof arg === "number" && !Token.isUnresolved(arg);

        if (isPlainString || isPlainNumber) {
          return `.${arg}`;
        }

        return `[${a}]`;
      }) // property access
      .join("");

    const targetExpr =
      Construct.isConstruct(this.target) && "fqn" in this.target
        ? this.target.fqn
        : this.resolveArg(context, this.target);

    const expr = `${targetExpr}${serializedArgs}`;

    return suppressBraces ? expr : `\${${expr}}`;
  }
}

// eslint-disable-next-line jsdoc/require-jsdoc
export function propertyAccess(target: Expression, args: Expression[]) {
  return new PropertyAccess(target, args) as IResolvable;
}

// eslint-disable-next-line jsdoc/require-jsdoc
class ConditionalExpression extends TFExpression {
  constructor(
    private condition: Expression,
    private trueValue: Expression,
    private falseValue: Expression,
  ) {
    super({ condition, trueValue, falseValue });
  }

  public resolve(context: IResolveContext): string {
    const suppressBraces = context.suppressBraces;
    context.suppressBraces = true;

    const condition = this.resolveArg(context, this.condition);
    const trueValue = this.resolveArg(context, this.trueValue);
    const falseValue = this.resolveArg(context, this.falseValue);

    const expr = `${condition} ? ${trueValue} : ${falseValue}`;

    return suppressBraces ? expr : `\${${expr}}`;
  }
}

/**
 * creates an expression like `true ? 1 : 0`
 */
export function conditional(
  condition: Expression,
  trueValue: Expression,
  falseValue: Expression,
) {
  return new ConditionalExpression(condition, trueValue, falseValue);
}

// https://developer.hashicorp.com/terraform/language/expressions/operators
export type Operator =
  | "!"
  | "-"
  | "*"
  | "/"
  | "%"
  | "+"
  | ">"
  | ">="
  | "<"
  | "<="
  | "=="
  | "!="
  | "&&"
  | "||";

/**
 * Base class for Operator Expressions
 * @internal
 */
export class OperatorExpression extends TFExpression {
  constructor(
    private operator: Operator,
    private left: Expression,
    private right?: Expression, // optional for ! and - operator
  ) {
    super({ operator, leftValue: left, rightValue: right });
  }

  public resolve(context: IResolveContext): string {
    const suppressBraces = context.suppressBraces;
    context.suppressBraces = true;

    const left = this.resolveArg(context, this.left);
    const right =
      this.right !== undefined
        ? this.resolveArg(context, this.right)
        : undefined;

    let expr = "";
    switch (this.operator) {
      case "!": {
        expr = `!${left}`; // no braces needed as ! has highest precedence
        break;
      }
      case "-": {
        if (right !== undefined) {
          // subtraction
          expr = `(${left} - ${right})`;
        } else {
          // negation
          expr = `-${left}`; // no braces needed as - has highest precedence
        }
        break;
      }
      default: {
        expr = `(${left} ${this.operator} ${right})`;
      }
    }

    return suppressBraces ? expr : `\${${expr}}`;
  }
}

// eslint-disable-next-line jsdoc/require-jsdoc
class FunctionCall extends TFExpression {
  constructor(
    private name: string,
    private args: Expression[],
  ) {
    super({ name, args });
  }

  public resolve(context: IResolveContext): string {
    // Recording here, at resolve time, is deliberate: a `Fn.*()`/
    // `TerraformProviderFunction.invoke()` call only produces a token: this
    // is the point where that token actually lands in a rendered stack, so
    // usage is attributed to the STACK whose synthesis is doing the
    // rendering - see `TerraformStack._usedFunctions` for why usage is
    // stack-owned rather than App-owned.
    //
    // `context.scope` IS the resolving TerraformStack for every
    // synth-driven resolve (App.synth, Testing.synth/synthHcl,
    // StackSynthesizer.synthesize all resolve elements with their owning
    // stack as scope), so `TerraformStack.isStack` is checked first as the
    // common case. `TerraformStack.of()` is a fallback for a scope that is
    // some other construct within a stack. If neither finds a stack (a
    // user-driven `Tokens.resolve()` call against a bare scope with no
    // stack in its ancestry), there is nowhere to record into - and nothing
    // would ever read it back to validate anyway - so recording is quietly
    // skipped rather than throwing.
    let stack: TerraformStack | undefined;
    if (TerraformStack.isStack(context.scope)) {
      stack = context.scope;
    } else {
      try {
        stack = TerraformStack.of(context.scope);
      } catch {
        stack = undefined;
      }
    }

    if (stack) {
      if (this.name.startsWith("provider::")) {
        stack._recordProviderFunctionUsage(this.name);
      } else {
        stack._recordFunctionUsage(this.name);
      }
    }

    const suppressBraces = context.suppressBraces;
    const originalIgnoreEscapes = context.ignoreEscapes;
    const originalWarnEscapes = context.warnEscapes;

    context.suppressBraces = true;
    context.ignoreEscapes = true;
    context.warnEscapes = true;

    const serializedArgs = this.args
      .map((arg) => this.resolveArg(context, arg))
      .join(", ");

    const expr = `${this.name}(${serializedArgs})`;

    context.ignoreEscapes = originalIgnoreEscapes;
    context.warnEscapes = originalWarnEscapes;

    return suppressBraces ? expr : `\${${expr}}`;
  }
}
// eslint-disable-next-line jsdoc/require-jsdoc
export function call(name: string, args: Expression[]) {
  return new FunctionCall(name, args) as IResolvable;
}

export const FOR_EXPRESSION_KEY = ref("key");
export const FOR_EXPRESSION_VALUE = ref("val");

/**
 * https://developer.hashicorp.com/terraform/language/expressions/for
 */
class ForExpression extends TFExpression {
  constructor(
    private input: Expression,
    private valueExpression: Expression,
    private keyExpression?: Expression,
  ) {
    super({ input, valueExpression, keyExpression });
  }

  public resolve(context: IResolveContext): string {
    const suppressBraces = context.suppressBraces;
    context.suppressBraces = true;
    context.iteratorContext = "FOR_EXPRESSION";
    const key = this.resolveArg(context, FOR_EXPRESSION_KEY);
    const value = this.resolveArg(context, FOR_EXPRESSION_VALUE);
    const input = this.resolveArg(context, this.input);
    const valueExpr = this.resolveExpressionPart(context, this.valueExpression);

    let expr: string;
    if (this.keyExpression) {
      const keyExpr = this.resolveExpressionPart(context, this.keyExpression);

      expr = `{ for ${key}, ${value} in ${input}: ${keyExpr} => ${valueExpr} }`;
    } else {
      expr = `[ for ${key}, ${value} in ${input}: ${valueExpr}]`;
    }

    return suppressBraces ? expr : `\${${expr}}`;
  }
}

/**
 * Creates a for expression, used for advanced internal use cases (e.g. in the @cdktn/aws-adapter)
 * It is currently not possible to use this via JSII in other languages. Usually you might want to
 * use TerraformIterator instead.
 *
 * @param input the input for the expression e.g. a list or an object
 * @param valueExpression will express the value e.g. [ for i in &lt;input&gt; : &lt;valueExpression&gt; ]
 * @param keyExpression if set will return an object e.g. { for k,v in &lt;input&gt; : &lt;keyExpression&gt; => &lt;valueExpression&gt;}
 * @returns a for expression
 *
 * The variables for key (for maps) / index (for lists) and value that are valid in the key- and valueExpression
 * can be referenced by using these constants: FOR_EXPRESSION_KEY and FOR_EXPRESSION_VALUE.
 *
 * Currently nesting for expressions is not supported due to this simplification.
 *
 * Currently does not support filtering elements (if clause) or grouping results
 */
export function forExpression(
  input: Expression,
  valueExpression: Expression,
  keyExpression?: Expression,
) {
  return new ForExpression(
    input,
    valueExpression,
    keyExpression,
  ) as IResolvable;
}

// eslint-disable-next-line jsdoc/require-jsdoc
class Dependable extends TFExpression {
  constructor(private dependable: ITerraformDependable) {
    super(dependable);
  }

  public resolve(context: IResolveContext): string {
    context.suppressBraces = true;

    return this.dependable.fqn;
  }
}
// eslint-disable-next-line jsdoc/require-jsdoc
export function dependable(dependable: ITerraformDependable): string {
  return Token.asString(new Dependable(dependable));
}

export type Expression =
  | Reference
  | FunctionCall
  | PropertyAccess
  | ConditionalExpression
  | OperatorExpression
  | Dependable
  | ForExpression
  | string
  | string[]
  | number
  | boolean
  | IResolvable
  | { [key: string]: any }
  | null
  | any // ultimately any valid Terraform type can be used as an expression
  | any[];
