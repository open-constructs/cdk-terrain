// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { IResolvable, IResolveContext } from "./tokens/resolvable";
import { Token } from "./tokens/token";
import { TypeConstraintSpec, typeConstraintExpression } from "./tfExpression";

const TYPE_EXPR_SYMBOL = Symbol.for("cdktn/TypeExpr");
const ATTRIBUTE_NAME = /^[_a-zA-Z][_a-zA-Z0-9-]*$/;

/**
 * A Terraform / OpenTofu type constraint expression, as accepted by the
 * `type` argument of `Fn.convert()` (and by a variable's `type`).
 *
 * Renders as a raw HCL type expression (never a quoted string), e.g.
 * `TypeExpr.list(TypeExpr.STRING)` -> `list(string)`. Use `toString()` to
 * pass one as `TerraformVariableConfig.type`.
 *
 * Object attribute names must be valid identifiers (letters, digits, `_` and
 * `-`, not starting with a digit or `-`). String defaults of
 * `TypeExpr.optional()` are always rendered as valid HCL string literals:
 * `"`, `\`, `${` and `%{` are escaped, while references are kept as is.
 * `TypeExpr.fromString()` is emitted verbatim, without any validation.
 */
export class TypeExpr implements IResolvable {
  public static readonly STRING = new TypeExpr({
    kind: "keyword",
    name: "string",
  });
  public static readonly NUMBER = new TypeExpr({
    kind: "keyword",
    name: "number",
  });
  public static readonly BOOL = new TypeExpr({ kind: "keyword", name: "bool" });
  /** `any` - the concrete type is inferred from the value. */
  public static readonly ANY = new TypeExpr({ kind: "keyword", name: "any" });

  /**
   * Returns true if `x` is a TypeExpr (also across copies of the library).
   */
  public static isTypeExpr(x: any): x is TypeExpr {
    return x !== null && typeof x === "object" && TYPE_EXPR_SYMBOL in x;
  }

  /** Rejects optional() anywhere but as an attribute type of object(). */
  private static element(ctor: string, element: TypeExpr): TypeConstraintSpec {
    if (element.spec.kind === "optional") {
      throw new Error(
        `TypeExpr.${ctor}(): TypeExpr.optional() is only valid as an attribute type inside TypeExpr.object()`,
      );
    }
    return element.spec;
  }

  /** `list(<element>)` */
  public static list(element: TypeExpr): TypeExpr {
    return new TypeExpr({
      kind: "collection",
      ctor: "list",
      element: TypeExpr.element("list", element),
    });
  }
  /** `set(<element>)` */
  public static set(element: TypeExpr): TypeExpr {
    return new TypeExpr({
      kind: "collection",
      ctor: "set",
      element: TypeExpr.element("set", element),
    });
  }
  /** `map(<element>)` */
  public static map(element: TypeExpr): TypeExpr {
    return new TypeExpr({
      kind: "collection",
      ctor: "map",
      element: TypeExpr.element("map", element),
    });
  }
  /** `tuple([<e1>, <e2>, ...])` */
  public static tuple(elements: TypeExpr[]): TypeExpr {
    return new TypeExpr({
      kind: "tuple",
      elements: elements.map((e) => TypeExpr.element("tuple", e)),
    });
  }
  /** `object({<name> = <type>, ...})`; wrap attribute types in `TypeExpr.optional()` to make them optional. */
  public static object(attributes: { [name: string]: TypeExpr }): TypeExpr {
    const specs: Record<string, TypeConstraintSpec> = {};
    for (const [name, t] of Object.entries(attributes)) {
      if (!ATTRIBUTE_NAME.test(name)) {
        throw new Error(
          `TypeExpr.object(): "${name}" is not a valid attribute name`,
        );
      }
      specs[name] = t.spec;
    }
    return new TypeExpr({ kind: "object", attributes: specs });
  }
  /**
   * `optional(<type>[, <default>])` - only valid as an attribute type of `TypeExpr.object()`.
   * @param defaultValue literal default applied when the attribute is absent or null
   */
  public static optional(
    attributeType: TypeExpr,
    defaultValue?: any,
  ): TypeExpr {
    if (attributeType.spec.kind === "optional") {
      throw new Error("TypeExpr.optional() cannot wrap another optional()");
    }
    return new TypeExpr({
      kind: "optional",
      type: attributeType.spec,
      hasDefault: defaultValue !== undefined,
      defaultValue,
    });
  }
  /**
   * Escape hatch: a type expression written by hand, emitted verbatim
   * (unquoted). It is not parsed or validated; an invalid expression only
   * fails once Terraform/OpenTofu reads the configuration.
   */
  public static fromString(expr: string): TypeExpr {
    return new TypeExpr({ kind: "raw", expr });
  }

  public readonly creationStack: string[] = [];
  private readonly expr: IResolvable;

  private constructor(private readonly spec: TypeConstraintSpec) {
    Object.defineProperty(this, TYPE_EXPR_SYMBOL, { value: true });
    this.expr = typeConstraintExpression(spec);
  }

  /**
   * Whether this is an `optional()` attribute type.
   * @internal
   */
  public get _isOptional(): boolean {
    return this.spec.kind === "optional";
  }

  public resolve(context: IResolveContext): any {
    if (this.spec.kind === "optional" && !context.suppressBraces) {
      throw new Error(
        "TypeExpr.optional() is only valid inside TypeExpr.object()",
      );
    }
    return this.expr.resolve(context);
  }

  /** The type expression as a token string, e.g. for `TerraformVariableConfig.type`. */
  public toString(): string {
    return Token.asString(this);
  }
}
