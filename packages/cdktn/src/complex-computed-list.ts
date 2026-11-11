// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { IResolvable, Token, IResolveContext } from "./tokens";
import {
  IInterpolatingParent,
  ITerraformAddressable,
} from "./terraform-addressable";
import {
  propertyAccess,
  Fn,
  TerraformIterator,
  DynamicListTerraformIterator,
} from ".";
import { captureCreationStack } from "./tokens/private/stack-trace";
import { providerVersionMismatch } from "./errors";

/**
 * Base class for a token that references a complex Terraform attribute and resolves to its interpolated address.
 */
abstract class ComplexResolvable implements IResolvable, ITerraformAddressable {
  public readonly creationStack: string[];

  /**
   * @internal
   */
  protected _fqn?: string;

  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
  ) {
    this.creationStack = captureCreationStack();
  }

  abstract computeFqn(): string;

  get fqn(): string {
    if (!this._fqn) {
      this._fqn = this.computeFqn();
    }

    return this._fqn;
  }

  resolve(_context: IResolveContext): any {
    return this.fqn;
  }

  toString(): string {
    return Token.asString(this);
  }
}

/**
 * Base class for a reference to a complex Terraform attribute whose nested attributes are read as typed tokens.
 */
abstract class ComplexComputedAttribute
  extends ComplexResolvable
  implements IInterpolatingParent
{
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
  ) {
    super(terraformResource, terraformAttribute);
  }

  public getStringAttribute(terraformAttribute: string) {
    return Token.asString(this.interpolationForAttribute(terraformAttribute));
  }

  public getNumberAttribute(terraformAttribute: string) {
    return Token.asNumber(this.interpolationForAttribute(terraformAttribute));
  }

  public getListAttribute(terraformAttribute: string) {
    return Token.asList(this.interpolationForAttribute(terraformAttribute));
  }

  public getBooleanAttribute(terraformAttribute: string): IResolvable {
    return this.interpolationForAttribute(terraformAttribute);
  }

  public getNumberListAttribute(terraformAttribute: string) {
    return Token.asNumberList(
      this.interpolationForAttribute(terraformAttribute),
    );
  }

  public getStringMapAttribute(terraformAttribute: string) {
    return Token.asStringMap(
      this.interpolationForAttribute(terraformAttribute),
    );
  }

  public getNumberMapAttribute(terraformAttribute: string) {
    return Token.asNumberMap(
      this.interpolationForAttribute(terraformAttribute),
    );
  }

  public getBooleanMapAttribute(terraformAttribute: string) {
    return Token.asBooleanMap(
      this.interpolationForAttribute(terraformAttribute),
    );
  }

  public getAnyMapAttribute(terraformAttribute: string) {
    return Token.asAnyMap(this.interpolationForAttribute(terraformAttribute));
  }

  public abstract interpolationForAttribute(terraformAttribute: string): any;
}

/**
 * Reference to a Terraform `map(string)` attribute, with each value read by key as a string token.
 */
export class StringMap
  extends ComplexResolvable
  implements ITerraformAddressable
{
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
  ) {
    super(terraformResource, terraformAttribute);
  }

  public lookup(key: string): string {
    return Token.asString(
      this.terraformResource.interpolationForAttribute(
        `${this.terraformAttribute}["${key}"]`,
      ),
    );
  }

  computeFqn(): string {
    return Token.asString(
      this.terraformResource.interpolationForAttribute(this.terraformAttribute),
    );
  }
}

/**
 * Reference to a Terraform `map(number)` attribute, with each value read by key as a number token.
 */
export class NumberMap
  extends ComplexResolvable
  implements ITerraformAddressable
{
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
  ) {
    super(terraformResource, terraformAttribute);
  }

  public lookup(key: string): number {
    return Token.asNumber(
      this.terraformResource.interpolationForAttribute(
        `${this.terraformAttribute}["${key}"]`,
      ),
    );
  }

  computeFqn(): string {
    return Token.asString(
      this.terraformResource.interpolationForAttribute(this.terraformAttribute),
    );
  }
}

/**
 * Reference to a Terraform `map(bool)` attribute, with each value read by key as a resolvable token.
 */
export class BooleanMap
  extends ComplexResolvable
  implements ITerraformAddressable
{
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
  ) {
    super(terraformResource, terraformAttribute);
  }

  public lookup(key: string): IResolvable {
    return this.terraformResource.interpolationForAttribute(
      `${this.terraformAttribute}["${key}"]`,
    );
  }

  computeFqn(): string {
    return Token.asString(
      this.terraformResource.interpolationForAttribute(this.terraformAttribute),
    );
  }
}

/**
 * Reference to a Terraform `map(any)` attribute, with each value read by key as an any-typed token.
 */
export class AnyMap extends ComplexResolvable implements ITerraformAddressable {
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
  ) {
    super(terraformResource, terraformAttribute);
  }

  public lookup(key: string): any {
    return Token.asAny(
      this.terraformResource.interpolationForAttribute(
        `${this.terraformAttribute}["${key}"]`,
      ),
    );
  }

  computeFqn(): string {
    return Token.asString(
      this.terraformResource.interpolationForAttribute(this.terraformAttribute),
    );
  }
}

/**
 * Reference to a Terraform `map(map(string))` attribute, with each inner map read by key as a StringMap.
 */
export class StringMapMap
  extends ComplexResolvable
  implements ITerraformAddressable
{
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
  ) {
    super(terraformResource, terraformAttribute);
  }

  public lookup(key: string): StringMap {
    return new StringMap(
      this.terraformResource,
      `${this.terraformAttribute}["${key}"]`,
    );
  }

  computeFqn(): string {
    return Token.asString(
      this.terraformResource.interpolationForAttribute(this.terraformAttribute),
    );
  }
}

/**
 * Reference to a Terraform `map(map(number))` attribute, with each inner map read by key as a NumberMap.
 */
export class NumberMapMap
  extends ComplexResolvable
  implements ITerraformAddressable
{
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
  ) {
    super(terraformResource, terraformAttribute);
  }

  public lookup(key: string): NumberMap {
    return new NumberMap(
      this.terraformResource,
      `${this.terraformAttribute}["${key}"]`,
    );
  }

  computeFqn(): string {
    return Token.asString(
      this.terraformResource.interpolationForAttribute(this.terraformAttribute),
    );
  }
}

/**
 * Reference to a Terraform `map(map(bool))` attribute, with each inner map read by key as a BooleanMap.
 */
export class BooleanMapMap
  extends ComplexResolvable
  implements ITerraformAddressable
{
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
  ) {
    super(terraformResource, terraformAttribute);
  }

  public lookup(key: string): BooleanMap {
    return new BooleanMap(
      this.terraformResource,
      `${this.terraformAttribute}["${key}"]`,
    );
  }

  computeFqn(): string {
    return Token.asString(
      this.terraformResource.interpolationForAttribute(this.terraformAttribute),
    );
  }
}

/**
 * Reference to a Terraform `map(map(any))` attribute, with each inner map read by key as an AnyMap.
 */
export class AnyMapMap
  extends ComplexResolvable
  implements ITerraformAddressable
{
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
  ) {
    super(terraformResource, terraformAttribute);
  }

  public lookup(key: string): AnyMap {
    return new AnyMap(
      this.terraformResource,
      `${this.terraformAttribute}["${key}"]`,
    );
  }

  computeFqn(): string {
    return Token.asString(
      this.terraformResource.interpolationForAttribute(this.terraformAttribute),
    );
  }
}

/**
 * @deprecated Going to be replaced by Array of ComplexListItem
 * and will be removed in the future
 */
export class ComplexComputedList extends ComplexComputedAttribute {
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
    protected complexComputedListIndex: string,
    protected wrapsSet?: boolean,
  ) {
    super(terraformResource, terraformAttribute);
    throw providerVersionMismatch();
  }

  public interpolationForAttribute(property: string) {
    if (this.wrapsSet) {
      return propertyAccess(
        Fn.tolist(
          this.terraformResource.interpolationForAttribute(
            this.terraformAttribute,
          ),
        ),
        [this.complexComputedListIndex, property],
      );
    }

    return this.terraformResource.interpolationForAttribute(
      `${this.terraformAttribute}[${this.complexComputedListIndex}].${property}`,
    );
  }

  computeFqn(): string {
    if (this.wrapsSet) {
      return Token.asString(
        propertyAccess(
          Fn.tolist(
            this.terraformResource.interpolationForAttribute(
              this.terraformAttribute,
            ),
          ),
          [this.complexComputedListIndex],
        ),
      );
    }

    return Token.asString(
      this.terraformResource.interpolationForAttribute(
        `${this.terraformAttribute}[${this.complexComputedListIndex}]`,
      ),
    );
  }
}

/**
 * Base class for a reference to a Terraform list or set attribute, converting sets with `tolist()` for index access.
 * Generated provider bindings extend it for lists and sets of nested blocks.
 */
export abstract class ComplexList
  extends ComplexResolvable
  implements ITerraformAddressable
{
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
    protected wrapsSet: boolean,
  ) {
    super(terraformResource, terraformAttribute);
  }

  computeFqn(): string {
    if (this.wrapsSet) {
      return Token.asString(
        Fn.tolist(
          this.terraformResource.interpolationForAttribute(
            this.terraformAttribute,
          ),
        ),
      );
    } else {
      return Token.asString(
        this.terraformResource.interpolationForAttribute(
          this.terraformAttribute,
        ),
      );
    }
  }

  /**
   * Creating an iterator for this complex list.
   * The list will be converted into a map with the mapKeyAttributeName as the key.
   * @param mapKeyAttributeName
   * @returns
   */
  public allWithMapKey(
    mapKeyAttributeName: string,
  ): DynamicListTerraformIterator {
    return TerraformIterator.fromComplexList(
      Token.asAny(this.computeFqn()),
      mapKeyAttributeName,
    );
  }
}

/**
 * Reference to a Terraform `list(bool)` attribute, with each element read by index as a resolvable token.
 */
export class BooleanList extends ComplexList {
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
    protected wrapsSet: boolean,
  ) {
    super(terraformResource, terraformAttribute, wrapsSet);
  }

  public get(index: number): IResolvable {
    return Fn.element(this, index);
  }
}

/**
 * Reference to a Terraform `list(list(string))` attribute, with each inner list read by index as a string list.
 */
export class StringListList extends ComplexList {
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
    protected wrapsSet: boolean,
  ) {
    super(terraformResource, terraformAttribute, wrapsSet);
  }

  public get(index: number) {
    return Token.asList(
      this.terraformResource.interpolationForAttribute(
        `${this.terraformAttribute}[${index}]`,
      ),
    );
  }
}

/**
 * Reference to a Terraform `list(list(number))` attribute, with each inner list read by index as a number list.
 */
export class NumberListList extends ComplexList {
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
    protected wrapsSet: boolean,
  ) {
    super(terraformResource, terraformAttribute, wrapsSet);
  }

  public get(index: number) {
    return Token.asNumberList(
      this.terraformResource.interpolationForAttribute(
        `${this.terraformAttribute}[${index}]`,
      ),
    );
  }
}

/**
 * Reference to a Terraform `list(list(bool))` attribute, with each inner list read by index as a resolvable token.
 */
export class BooleanListList extends ComplexList {
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
    protected wrapsSet: boolean,
  ) {
    super(terraformResource, terraformAttribute, wrapsSet);
  }

  public get(index: number) {
    // This isn't fully supported
    return this.terraformResource.interpolationForAttribute(
      `${this.terraformAttribute}[${index}]`,
    );
  }
}

/**
 * Reference to a Terraform `list(list(any))` attribute, with each inner list read by index as a resolvable token.
 */
export class AnyListList extends ComplexList {
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
    protected wrapsSet: boolean,
  ) {
    super(terraformResource, terraformAttribute, wrapsSet);
  }

  public get(index: number) {
    // This isn't fully supported
    return this.terraformResource.interpolationForAttribute(
      `${this.terraformAttribute}[${index}]`,
    );
  }
}

/**
 * Base class for a reference to a Terraform map attribute.
 * Generated provider bindings extend it for maps of nested objects and maps of lists of nested objects.
 */
export abstract class ComplexMap
  extends ComplexResolvable
  implements ITerraformAddressable
{
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
  ) {
    super(terraformResource, terraformAttribute);
  }

  computeFqn(): string {
    return Token.asString(
      this.terraformResource.interpolationForAttribute(this.terraformAttribute),
    );
  }

  interpolationForAttribute(property: string) {
    return propertyAccess(
      this.terraformResource.interpolationForAttribute(this.terraformAttribute),
      [property],
    );
  }
}

/**
 * Reference to a single Terraform object attribute, optionally addressed by index within a list or set.
 * Generated provider bindings extend it for the output reference of each nested block.
 */
export class ComplexObject extends ComplexComputedAttribute {
  /**
   * @param terraformResource
   * @param terraformAttribute
   * @param complexObjectIndex the index of the complex object in a list
   * @param complexObjectIsFromSet set to true if this item is from inside a set and needs tolist() for accessing it
   *                               set to "0" for single list items
   */
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
    protected complexObjectIsFromSet: boolean,
    protected complexObjectIndex?: number | string,
  ) {
    super(terraformResource, terraformAttribute);
  }

  public interpolationForAttribute(property: string) {
    if (this.complexObjectIsFromSet) {
      return propertyAccess(
        Fn.tolist(
          this.terraformResource.interpolationForAttribute(
            this.terraformAttribute,
          ),
        ),
        [this.complexObjectIndex, property],
      );
    }

    return this.terraformResource.interpolationForAttribute(
      this.complexObjectIndex !== undefined
        ? `${this.terraformAttribute}[${this.complexObjectIndex}].${property}`
        : `${this.terraformAttribute}.${property}`,
    );
  }

  protected interpolationAsList() {
    return this.terraformResource.interpolationForAttribute(
      `${this.terraformAttribute}.*`,
    );
  }

  computeFqn(): string {
    if (this.complexObjectIsFromSet) {
      return Token.asString(
        propertyAccess(
          Fn.tolist(
            this.terraformResource.interpolationForAttribute(
              this.terraformAttribute,
            ),
          ),
          [this.complexObjectIndex],
        ),
      );
    }

    return Token.asString(
      this.terraformResource.interpolationForAttribute(
        this.complexObjectIndex !== undefined
          ? `${this.terraformAttribute}[${this.complexObjectIndex}]`
          : this.terraformAttribute,
      ),
    );
  }
}

/**
 * Base class for a reference to a Terraform list or set of maps, converting sets with `tolist()` for index access.
 * Generated provider bindings extend it for lists of maps and lists of lists of nested objects.
 */
export abstract class MapList
  extends ComplexResolvable
  implements ITerraformAddressable, IInterpolatingParent
{
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
    protected wrapsSet: boolean,
  ) {
    super(terraformResource, terraformAttribute);
  }

  computeFqn(): string {
    if (this.wrapsSet) {
      return Token.asString(
        Fn.tolist(
          this.terraformResource.interpolationForAttribute(
            this.terraformAttribute,
          ),
        ),
      );
    } else {
      return Token.asString(
        this.terraformResource.interpolationForAttribute(
          this.terraformAttribute,
        ),
      );
    }
  }

  interpolationForAttribute(property: string): IResolvable {
    if (this.wrapsSet) {
      const matches = property.match(/\[([^\]]*)\]/); // need to extract out the index
      if (matches) {
        return propertyAccess(
          Fn.tolist(
            this.terraformResource.interpolationForAttribute(
              this.terraformAttribute,
            ),
          ),
          [matches[1], property],
        );
      }
    }

    return this.terraformResource.interpolationForAttribute(
      `${this.terraformAttribute}${property}`,
    );
  }
}

/**
 * Reference to a Terraform `list(map(string))` attribute, with each map read by index as a StringMap.
 */
export class StringMapList extends MapList {
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
    protected wrapsSet: boolean,
  ) {
    super(terraformResource, terraformAttribute, wrapsSet);
  }

  public get(index: number) {
    return new StringMap(this, `[${index}]`);
  }
}

/**
 * Reference to a Terraform `list(map(number))` attribute, with each map read by index as a NumberMap.
 */
export class NumberMapList extends MapList {
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
    protected wrapsSet: boolean,
  ) {
    super(terraformResource, terraformAttribute, wrapsSet);
  }

  public get(index: number) {
    return new NumberMap(this, `[${index}]`);
  }
}

/**
 * Reference to a Terraform `list(map(bool))` attribute, with each map read by index as a BooleanMap.
 */
export class BooleanMapList extends MapList {
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
    protected wrapsSet: boolean,
  ) {
    super(terraformResource, terraformAttribute, wrapsSet);
  }

  public get(index: number) {
    return new BooleanMap(this, `[${index}]`);
  }
}

/**
 * Reference to a Terraform `list(map(any))` attribute, with each map read by index as an AnyMap.
 */
export class AnyMapList extends MapList {
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
    protected wrapsSet: boolean,
  ) {
    super(terraformResource, terraformAttribute, wrapsSet);
  }

  public get(index: number) {
    return new AnyMap(this, `[${index}]`);
  }
}

/**
 * Reference to a Terraform `map(list(string))` attribute, with each list read by key as a string list.
 */
export class StringListMap extends ComplexMap {
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
  ) {
    super(terraformResource, terraformAttribute);
  }

  public get(key: string) {
    return Token.asList(
      this.terraformResource.interpolationForAttribute(
        `${this.terraformAttribute}[${key}]`,
      ),
    );
  }
}

/**
 * Reference to a Terraform `map(list(number))` attribute, with each list read by key as a number list.
 */
export class NumberListMap extends ComplexMap {
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
  ) {
    super(terraformResource, terraformAttribute);
  }

  public get(key: string) {
    return Token.asNumberList(
      this.terraformResource.interpolationForAttribute(
        `${this.terraformAttribute}[${key}]`,
      ),
    );
  }
}

/**
 * Reference to a Terraform `map(list(bool))` attribute, with each list read by key as a resolvable token.
 */
export class BooleanListMap extends ComplexMap {
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
  ) {
    super(terraformResource, terraformAttribute);
  }

  public get(key: string) {
    // This isn't fully supported
    return this.terraformResource.interpolationForAttribute(
      `${this.terraformAttribute}[${key}]`,
    );
  }
}

/**
 * Reference to a Terraform `map(list(any))` attribute, with each list read by key as a resolvable token.
 */
export class AnyListMap extends ComplexMap {
  constructor(
    protected terraformResource: IInterpolatingParent,
    protected terraformAttribute: string,
  ) {
    super(terraformResource, terraformAttribute);
  }

  public get(key: string) {
    // This isn't fully supported
    return this.terraformResource.interpolationForAttribute(
      `${this.terraformAttribute}[${key}]`,
    );
  }
}
