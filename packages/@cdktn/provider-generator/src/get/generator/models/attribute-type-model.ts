// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Struct } from "./struct";
import { uppercaseFirst, downcaseFirst } from "../../../util";
import { resolveStoredClassName } from "./supported-stored-classes";

export interface AttributeTypeModel {
  readonly struct?: Struct; // complex object type contained within the type
  readonly isComplex: boolean; // basically the same as having a struct
  getStoredClassInitializer(name: string): string; // initializer for keeping class needed to keep track of reference access
  readonly storedClassType: string; // used mainly by collection types to generate their stored class initializer
  readonly inputTypeDefinition: string; // this is the type used for inputting values
  getAttributeAccessFunction(name: string): string; // this is for getting reference for simple types
  readonly toTerraformFunction: string; // this is for converting input values to Terraform syntax
  readonly toHclTerraformFunction: string; // this is for converting input values to Terraform syntax in HCL
  readonly typeModelType: string; // so we don't need to use instanceof
  readonly hasReferenceClass: boolean; // used to determine if a stored_class getter should be used
  readonly isTokenizable: boolean; // can the type be represented by a token type
  readonly isStoredClassUnavailable: boolean; // true when no "cdktn.<Name>" stored class (not even a collapsed nearest-Any wrapper) is available for this type
}

// Describes the Terraform type of an attribute as its `list(...)`/`set(...)`/`map(...)`
// composed notation (matching how Terraform itself describes nested collection types),
// for use in generated JSDoc. Used only for collapsed/fallback getters (see
// AttributesEmitter) so it never needs to be exhaustive/perfectly stable for every shape.
export function describeTerraformType(model: AttributeTypeModel): string {
  switch (model.typeModelType) {
    case "list":
      return `list(${describeTerraformType(
        (model as CollectionAttributeTypeModel).elementType,
      )})`;
    case "set":
      return `set(${describeTerraformType(
        (model as CollectionAttributeTypeModel).elementType,
      )})`;
    case "map":
      return `map(${describeTerraformType(
        (model as CollectionAttributeTypeModel).elementType,
      )})`;
    case "struct":
      return "object";
    default:
      // Covers both SimpleAttributeTypeModel (storedClassType is the Terraform primitive
      // name, e.g. "string" | "number" | "boolean" | "any") and SkippedAttributeTypeModel
      // (storedClassType is always "any").
      return model.storedClassType === "boolean"
        ? "bool"
        : model.storedClassType;
  }
}

export class SkippedAttributeTypeModel implements AttributeTypeModel {
  constructor() {}

  get typeModelType() {
    return "simple";
  }

  get struct() {
    return undefined;
  }

  get isComplex() {
    return false;
  }

  getStoredClassInitializer(_name: string) {
    // not used
    return "";
  }

  get storedClassType() {
    return "any";
  }

  get inputTypeDefinition() {
    return "any";
  }

  getAttributeAccessFunction(name: string) {
    return `this.interpolationForAttribute('${name}')`;
  }

  get toTerraformFunction() {
    return `cdktn.anyToTerraform`;
  }

  get toHclTerraformFunction() {
    return `cdktn.anyToHclTerraform`;
  }

  get hasReferenceClass() {
    return false;
  }

  get isTokenizable() {
    return false;
  }

  get isStoredClassUnavailable() {
    return false;
  }
}

export class SimpleAttributeTypeModel implements AttributeTypeModel {
  constructor(public readonly type: string) {}

  get typeModelType() {
    return "simple";
  }

  get struct() {
    return undefined;
  }

  get isComplex() {
    return false;
  }

  getStoredClassInitializer(_name: string) {
    // not used
    return "";
  }

  get storedClassType() {
    return this.type;
  }

  get inputTypeDefinition() {
    if (this.type === "boolean") {
      return "boolean | cdktn.IResolvable";
    } else {
      return this.type;
    }
  }

  getAttributeAccessFunction(name: string) {
    return `this.get${uppercaseFirst(this.type)}Attribute('${name}')`;
  }

  get toTerraformFunction() {
    return `cdktn.${this.type}ToTerraform`;
  }

  get toHclTerraformFunction() {
    return `cdktn.${this.type}ToHclTerraform`;
  }

  get hasReferenceClass() {
    return false;
  }

  get isTokenizable() {
    return true;
  }

  get isStoredClassUnavailable() {
    return false;
  }
}

export class StructAttributeTypeModel implements AttributeTypeModel {
  constructor(public readonly struct: Struct) {}

  get typeModelType() {
    return "struct";
  }

  get isComplex() {
    return true;
  }

  getStoredClassInitializer(name: string) {
    return `new ${this.struct.outputReferenceName}(this, "${name}")`;
  }

  get storedClassType() {
    return this.struct.name;
  }

  get inputTypeDefinition() {
    return this.struct.name;
  }

  getAttributeAccessFunction(name: string) {
    // This shouln't actually be called
    return `this.interpolationForAttribute('${name}')`;
  }

  get toTerraformFunction() {
    return `${downcaseFirst(this.struct.name)}ToTerraform`;
  }

  get toHclTerraformFunction() {
    return `${downcaseFirst(this.struct.name)}ToHclTerraform`;
  }

  get hasReferenceClass() {
    return true;
  }

  get isTokenizable() {
    return false;
  }

  get isStoredClassUnavailable() {
    return false;
  }
}

export interface CollectionAttributeTypeModel extends AttributeTypeModel {
  elementType: AttributeTypeModel;
  // Resolves the "cdktn.<name>" stored class to instantiate for this (non-complex)
  // collection type, and whether that resolution collapsed a deeper, unsupported nesting
  // into the nearest typed "Any"-wrapper. undefined only defensively - see
  // resolveStoredClassName in supported-stored-classes.ts.
  readonly resolvedStoredClass:
    | { name: string; collapsed: boolean }
    | undefined;
}

export class ListAttributeTypeModel implements CollectionAttributeTypeModel {
  constructor(
    public readonly elementType: AttributeTypeModel,
    public readonly isSingleItem: boolean,
    private readonly isBlock: boolean,
  ) {
    if (this.struct) {
      this.struct.isSingleItem = this.isSingleItem || false;
    }
  }

  get typeModelType() {
    return "list";
  }

  get struct() {
    return this.elementType.struct;
  }

  get isComplex() {
    return this.elementType.isComplex;
  }

  getStoredClassInitializer(name: string) {
    if (this.isSingleItem) {
      return `new ${this.elementType.storedClassType}OutputReference(this, "${name}")`;
    } else {
      if (this.isComplex) {
        return `new ${this.storedClassType}(this, "${name}", false)`;
      } else {
        return `new cdktn.${this.resolvedStoredClass!.name}(this, "${name}", false)`;
      }
    }
  }

  get storedClassType() {
    return `${this.elementType.storedClassType}List`;
  }

  get resolvedStoredClass() {
    return resolveStoredClassName(
      this.storedClassType,
      this.elementType.typeModelType,
    );
  }

  get inputTypeDefinition() {
    if (this.isSingleItem) {
      return this.elementType.inputTypeDefinition;
    } else if (this.elementType.storedClassType === "boolean") {
      return "Array<boolean | cdktn.IResolvable> | cdktn.IResolvable";
    } else if (this.isComplex) {
      return `${this.elementType.storedClassType}[] | cdktn.IResolvable`;
    } else if (this.elementType.typeModelType !== "simple") {
      return `${this.elementType.inputTypeDefinition}[] | cdktn.IResolvable`;
    } else {
      return `${this.elementType.inputTypeDefinition}[]`;
    }
  }

  getAttributeAccessFunction(name: string) {
    switch (this.elementType.storedClassType) {
      case "string":
        return `this.getListAttribute('${name}')`;
      case "number":
        return `this.getNumberListAttribute('${name}')`;
    }

    return `this.interpolationForAttribute('${name}')`;
  }

  get toTerraformFunction() {
    if (this.isSingleItem) {
      return this.elementType.toTerraformFunction;
    }
    return `cdktn.listMapper(${this.elementType.toTerraformFunction}, ${this.isBlock})`;
  }

  get toHclTerraformFunction() {
    if (this.isSingleItem) {
      return this.elementType.toHclTerraformFunction;
    }

    return `cdktn.listMapperHcl(${this.elementType.toHclTerraformFunction}, ${this.isBlock})`;
  }

  get hasReferenceClass() {
    return this.isSingleItem || this.isComplex;
  }

  get isTokenizable() {
    switch (this.elementType.storedClassType) {
      case "string":
        return true;
      case "number":
        return true;
      default:
        return false;
    }
  }

  // Complex (struct) elements generate their own class in the provider output, so they
  // are always fine. Otherwise a stored class is only emitted if resolvedStoredClass
  // finds one - see getStoredClassInitializer above. Note: hasReferenceClass (which
  // triggers a stored_class getter) is only ever true here when isSingleItem or isComplex
  // is true, and isSingleItem is only set for struct/block nesting (which is also
  // isComplex), so this check only needs to guard the non-complex, non-single-item case.
  //
  // storedClassType is itself built up recursively (elementType.storedClassType is
  // composed the same way for nested collections), so it already fully encodes the
  // entire nested chain in one string (e.g. map(map(list(string))) composes all the way
  // up to "stringListMapMap"). resolvedStoredClass first checks this type's own composed
  // name (e.g. "StringListMapMap") against the fixed set of hand-written core classes; if
  // that name doesn't exist, it falls back to the nearest typed "Any"-wrapper that still
  // encodes this type's own layer and its element's layer (e.g. "AnyMapMap"), collapsing
  // only the unsupported inner shape while preserving typed navigation for the outer
  // layers; only if neither exists does it fall through to the plain, untyped getter (see
  // AttributeModel.getterType). It must NOT also OR in
  // elementType.isStoredClassUnavailable, since an inner element's un-composed name (e.g.
  // "StringList" for a plain list(string) nested inside a map) is never separately
  // instantiated and is irrelevant on its own; ORing it in would produce false positives
  // that regress supported nestings such as map(list(string)) => cdktn.StringListMap.
  get isStoredClassUnavailable() {
    if (this.isComplex) {
      return false;
    }
    return this.resolvedStoredClass === undefined;
  }
}

export class SetAttributeTypeModel implements CollectionAttributeTypeModel {
  constructor(
    public readonly elementType: AttributeTypeModel,
    public readonly isSingleItem: boolean,
    private readonly isBlock: boolean,
  ) {
    if (this.struct) {
      this.struct.isSingleItem = this.isSingleItem || false;
    }
  }

  get typeModelType() {
    return "set";
  }

  get struct() {
    return this.elementType.struct;
  }

  get isComplex() {
    return this.elementType.isComplex;
  }

  getStoredClassInitializer(name: string) {
    if (this.isSingleItem) {
      return `new ${this.elementType.storedClassType}OutputReference(this, "${name}")`;
    } else {
      if (this.isComplex) {
        return `new ${this.storedClassType}(this, "${name}", true)`;
      } else {
        return `new cdktn.${this.resolvedStoredClass!.name}(this, "${name}", true)`;
      }
    }
  }

  get storedClassType() {
    return `${this.elementType.storedClassType}List`;
  }

  get resolvedStoredClass() {
    return resolveStoredClassName(
      this.storedClassType,
      this.elementType.typeModelType,
    );
  }

  get inputTypeDefinition() {
    if (this.isSingleItem) {
      return this.elementType.inputTypeDefinition;
    } else if (this.elementType.storedClassType === "boolean") {
      return "Array<boolean | cdktn.IResolvable> | cdktn.IResolvable";
    } else if (this.isComplex) {
      return `${this.elementType.storedClassType}[] | cdktn.IResolvable`;
    } else if (this.elementType.typeModelType !== "simple") {
      return `${this.elementType.inputTypeDefinition}[] | cdktn.IResolvable`;
    } else {
      return `${this.elementType.inputTypeDefinition}[]`;
    }
  }

  getAttributeAccessFunction(name: string) {
    switch (this.elementType.storedClassType) {
      case "string":
        return `cdktn.Fn.tolist(this.getListAttribute('${name}'))`;
      case "number":
        return `cdktn.Token.asNumberList(cdktn.Fn.tolist(this.getNumberListAttribute('${name}')))`;
    }

    // Token.asAny is required because tolist returns an Array encoded token which the listMapper
    // would try to map over when this is passed to another resource. With Token.asAny() it is left
    // as is by the listMapper and is later properly resolved to a reference
    // (this only works in TypeScript currently, same as for referencing lists
    // [see "interpolationForAttribute(...)" further below])
    return `cdktn.Token.asAny(cdktn.Fn.tolist(this.interpolationForAttribute('${name}')))`;
  }

  get toTerraformFunction() {
    if (this.isSingleItem) {
      return this.elementType.toTerraformFunction;
    } else {
      return `cdktn.listMapper(${this.elementType.toTerraformFunction}, ${this.isBlock})`;
    }
  }

  get toHclTerraformFunction() {
    if (this.isSingleItem) {
      return this.elementType.toHclTerraformFunction;
    }
    return `cdktn.listMapperHcl(${this.elementType.toHclTerraformFunction}, ${this.isBlock})`;
  }

  get hasReferenceClass() {
    return this.isSingleItem || this.isComplex;
  }

  get isTokenizable() {
    switch (this.elementType.storedClassType) {
      case "string":
        return true;
      case "number":
        return true;
      default:
        return false;
    }
  }

  // See comment on ListAttributeTypeModel.isStoredClassUnavailable above - same
  // reasoning applies here.
  get isStoredClassUnavailable() {
    if (this.isComplex) {
      return false;
    }
    return this.resolvedStoredClass === undefined;
  }
}

export class MapAttributeTypeModel implements CollectionAttributeTypeModel {
  constructor(public readonly elementType: AttributeTypeModel) {}

  get typeModelType() {
    return "map";
  }

  get struct() {
    return this.elementType.struct;
  }

  get isComplex() {
    return this.elementType.isComplex;
  }

  getStoredClassInitializer(name: string) {
    if (this.isComplex) {
      return `new ${this.storedClassType}(this, "${name}")`;
    } else {
      return `new cdktn.${this.resolvedStoredClass!.name}(this, "${name}")`;
    }
  }

  get storedClassType() {
    return `${this.elementType.storedClassType}Map`;
  }

  get resolvedStoredClass() {
    return resolveStoredClassName(
      this.storedClassType,
      this.elementType.typeModelType,
    );
  }

  get inputTypeDefinition() {
    // map of booleans has token support, but booleans don't
    if (this.elementType.storedClassType === "boolean") {
      return `{ [key: string]: (${this.elementType.storedClassType} | cdktn.IResolvable) }`;
    } else if (this.isComplex) {
      return `{ [key: string]: ${this.elementType.storedClassType} } | cdktn.IResolvable`;
    } else if (this.elementType.typeModelType !== "simple") {
      return `{ [key: string]: ${this.elementType.inputTypeDefinition} } | cdktn.IResolvable`;
    } else {
      return `{ [key: string]: ${this.elementType.storedClassType} }`;
    }
  }

  getAttributeAccessFunction(name: string) {
    if (!this.isComplex && this.elementType.typeModelType !== "simple") {
      return `this.interpolationForAttribute('${name}')`;
    }

    return `this.get${uppercaseFirst(
      this.storedClassType,
    )}Attribute('${name}')`;
  }

  get toTerraformFunction() {
    return `cdktn.hashMapper(${this.elementType.toTerraformFunction})`;
  }

  get toHclTerraformFunction() {
    return `cdktn.hashMapperHcl(${this.elementType.toHclTerraformFunction})`;
  }

  get hasReferenceClass() {
    return this.isComplex;
  }

  get isTokenizable() {
    switch (this.elementType.storedClassType) {
      case "string":
        return true;
      case "number":
        return true;
      case "boolean":
        return true;
      case "any":
        return true;
      default:
        return false;
    }
  }

  // See comment on ListAttributeTypeModel.isStoredClassUnavailable above - same
  // reasoning applies here (MapAttributeTypeModel.hasReferenceClass is just isComplex).
  get isStoredClassUnavailable() {
    if (this.isComplex) {
      return false;
    }
    return this.resolvedStoredClass === undefined;
  }
}
