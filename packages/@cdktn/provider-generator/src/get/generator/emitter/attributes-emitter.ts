// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { CodeMaker } from "codemaker";
import {
  AttributeModel,
  CollectionAttributeTypeModel,
  describeTerraformType,
} from "../models";
import { CUSTOM_DEFAULTS } from "../custom-defaults";
import { sanitizedComment } from "../sanitized-comments";

function titleCase(value: string) {
  return value[0].toUpperCase() + value.slice(1);
}

export class AttributesEmitter {
  constructor(private code: CodeMaker) {}

  public emit(att: AttributeModel, escapeReset: boolean, escapeInput: boolean) {
    this.code.line();
    this.code.line(
      `// ${att.terraformName} - computed: ${att.computed}, optional: ${att.isOptional}, required: ${att.isRequired}`,
    );

    const isStored = att.isStored;
    const hasResetMethod =
      isStored && !att.isRequired && att.setterType._type !== "none";
    const hasInputMethod = isStored && att.setterType._type !== "none";

    const getterType = att.getterType;

    if (getterType._type === "stored_class") {
      this.code.line(
        `private ${att.storageName} = ${this.storedClassInit(att)};`,
      );
    } else if (isStored) {
      this.code.line(
        `private ${att.storageName}?: ${att.type.inputTypeDefinition}; `,
      );
    }

    this.emitStoredClassBoundaryDoc(att);

    switch (getterType._type) {
      case "plain":
        this.emitWriteOnlyGetterDeprecationNotice(att);
        this.code.openBlock(`public get ${att.name}()`);
        this.code.line(`return ${this.determineGetAttCall(att)};`);
        this.code.closeBlock();
        break;

      case "args":
        this.emitWriteOnlyGetterDeprecationNotice(att);
        this.code.openBlock(
          `public ${att.name}(${getterType.args})${
            getterType.returnType ? ": " + getterType.returnType : ""
          }`,
        );
        this.code.line(`return ${getterType.returnStatement};`);
        this.code.closeBlock();
        break;

      case "stored_class":
        this.emitWriteOnlyGetterDeprecationNotice(att);
        this.code.openBlock(`public get ${att.name}()`);
        this.code.line(`return this.${att.storageName};`);
        this.code.closeBlock();
        break;
    }

    const setterType = att.setterType;

    // Write-only usage is registered at resolve time instead (see
    // #emitToTerraform/#emitToHclTerraform and
    // TerraformResource#markWriteOnlyAttribute), so setters intentionally
    // emit no registration call here: they only store the value.
    switch (setterType._type) {
      case "set":
        this.code.openBlock(
          `public set ${att.name}(value: ${setterType.type})`,
        );
        this.code.line(`this.${att.storageName} = value;`);
        this.code.closeBlock();
        break;

      case "put":
        this.code.openBlock(
          `public put${titleCase(att.name)}(value: ${setterType.type})`,
        );
        this.code.line(`this.${att.storageName} = value;`);
        this.code.closeBlock();
        break;

      case "stored_class":
        this.code.openBlock(
          `public put${titleCase(att.name)}(value: ${setterType.type})`,
        );
        this.code.line(`this.${att.storageName}.internalValue = value;`);
        this.code.closeBlock();
        break;
    }

    if (hasResetMethod) {
      this.code.openBlock(
        `public ${this.getResetName(att.name, escapeReset)}()`,
      );

      if (setterType._type === "stored_class") {
        this.code.line(`this.${att.storageName}.internalValue = undefined;`);
      } else {
        this.code.line(`this.${att.storageName} = undefined;`);
      }

      this.code.closeBlock();
    }

    if (hasInputMethod) {
      this.code.line(`// Temporarily expose input value. Use with caution.`);
      this.code.openBlock(
        `public get ${this.getInputName(att, escapeInput)}()`,
      );

      if (setterType._type === "stored_class") {
        this.code.line(`return this.${att.storageName}.internalValue;`);
      } else {
        this.code.line(`return this.${att.storageName};`);
      }

      this.code.closeBlock();
    }
  }

  // emits a @deprecated JSDoc block above a write-only attribute's getter:
  // providers never persist/return write-only values, so the state-backed
  // getter always reads back null by protocol contract
  private emitWriteOnlyGetterDeprecationNotice(att: AttributeModel) {
    if (!att.isWriteOnly) {
      return;
    }

    const comment = sanitizedComment(this.code);
    comment.line(
      "@deprecated Write-only: the provider never returns this value; reading it always yields null by protocol contract. The getter remains for compatibility and will be removed in a future prebuilt-provider major.",
    );
    comment.end();
  }

  // returns an invocation of a stored class, e.g. 'new DeplotmentMetadataOutputReference(this, "metadata")'
  private storedClassInit(att: AttributeModel) {
    return att.type.getStoredClassInitializer(att.terraformName);
  }

  // Emits a JSDoc block documenting the Terraform type immediately before getters whose
  // stored class either collapsed a deeper, unsupported nesting into the nearest typed
  // "Any"-wrapper, or fell all the way back to a plain, untyped getter because no stored
  // class (not even a collapsed one) is available. Normal, fully-supported getters get no
  // such doc, to limit snapshot churn.
  private emitStoredClassBoundaryDoc(att: AttributeModel) {
    const boundaryKind = att.storedClassBoundaryKind;
    if (!boundaryKind) {
      return;
    }

    const comment = sanitizedComment(this.code);
    comment.line(`Terraform type: \`${describeTerraformType(att.type)}\`.`);

    if (boundaryKind === "collapsed") {
      const collapsedName = (att.type as CollectionAttributeTypeModel)
        .resolvedStoredClass!.name;
      comment.line(
        `This nesting is deeper than the typed wrapper classes in the core cdktn package; it is exposed as \`${collapsedName}\` and values below that boundary are untyped tokens.`,
      );
    } else {
      comment.line(
        `No typed wrapper class for this shape exists in the core cdktn package; the value is returned as an untyped token (IResolvable).`,
      );
    }

    comment.end();
  }

  public determineGetAttCall(att: AttributeModel): string {
    if (att.isProvider) {
      return `this.${att.storageName}`;
    }

    return att.type.getAttributeAccessFunction(att.terraformName);
  }

  public needsInputEscape(
    att: AttributeModel,
    attributes: AttributeModel[],
  ): boolean {
    return (
      attributes.find((a) =>
        a.terraformName.match(`^${att.terraformName}_input$`),
      ) instanceof AttributeModel
    );
  }

  public getInputName(att: AttributeModel, escape: boolean) {
    if (escape) {
      return `${att.name}TfInput`;
    } else {
      return `${att.name}Input`;
    }
  }

  public needsResetEscape(
    att: AttributeModel,
    attributes: AttributeModel[],
  ): boolean {
    return (
      attributes.find((a) =>
        a.terraformName.match(`^reset_${att.terraformName}$`),
      ) instanceof AttributeModel
    );
  }

  public getResetName(name: string, escape: boolean) {
    if (!name) return name;
    if (escape) {
      return `resetTf${titleCase(name)}`;
    } else {
      return `reset${titleCase(name)}`;
    }
  }

  /**
   * @param canRegisterProviderFeatureUsage Whether this attribute's mapped
   * value should be wrapped in `this.markWriteOnlyAttribute(...)` when it is
   * write-only. Only true for attributes emitted on classes that extend
   * TerraformResource (managed resources) - struct-level `xToTerraform`/
   * `xToHclTerraform` functions are standalone functions with no `this` of
   * that type, so they never pass this (see ResourceEmitter's
   * `supportsWriteOnlyRegistration`).
   */
  public emitToHclTerraform(
    att: AttributeModel,
    isStruct: boolean,
    canRegisterProviderFeatureUsage = false,
  ) {
    const type = att.type;
    const context = isStruct ? "struct!" : "this";
    const name = isStruct ? att.name : att.storageName;
    const customDefault = CUSTOM_DEFAULTS[att.terraformFullName];

    const varReference = `${context}.${name}${
      !isStruct &&
      type.isComplex &&
      !att.isProvider &&
      (type.struct?.isClass || att.getterType._type === "stored_class")
        ? ".internalValue"
        : ""
    }`;
    const defaultCheck =
      customDefault !== undefined
        ? `${varReference} === undefined ? ${customDefault} : `
        : "";

    const mappedValue = `${defaultCheck}${type.toHclTerraformFunction}(${varReference})`;
    // markWriteOnlyAttribute() passes `undefined`/`null` straight through
    // unwrapped, so this keeps the "remove undefined attributes" filter in
    // the caller (which checks `value.value !== undefined`) working exactly
    // as before for unset/cleared write-only attributes.
    const value =
      att.isWriteOnly && canRegisterProviderFeatureUsage
        ? `this.markWriteOnlyAttribute(${mappedValue})`
        : mappedValue;
    const isBlock = att.type.isComplex;
    const tt = att.type.typeModelType;

    this.code.open(`${att.terraformName}: {`);
    this.code.line(`value: ${value},`);
    this.code.line(`isBlock: ${isBlock},`);
    this.code.line(`type: "${tt}",`);
    this.code.line(`storageClassType: "${att.type.storedClassType}",`);
    this.code.close("},");
  }

  public emitToTerraform(
    att: AttributeModel,
    isStruct: boolean,
    canRegisterProviderFeatureUsage = false,
  ) {
    const type = att.type;
    const context = isStruct ? "struct!" : "this";
    const name = isStruct ? att.name : att.storageName;
    const customDefault = CUSTOM_DEFAULTS[att.terraformFullName];

    const varReference = `${context}.${name}${
      !isStruct &&
      type.isComplex &&
      !att.isProvider &&
      (type.struct?.isClass || att.getterType._type === "stored_class")
        ? ".internalValue"
        : ""
    }`;
    const defaultCheck =
      customDefault !== undefined
        ? `${varReference} === undefined ? ${customDefault} : `
        : "";

    const mappedValue = `${defaultCheck}${type.toTerraformFunction}(${varReference})`;
    // markWriteOnlyAttribute() passes `undefined`/`null` straight through
    // unwrapped, so an unset/cleared write-only attribute still vanishes
    // from the returned object exactly as before (see the "skip undefined"
    // step in tokens/private/resolve.ts).
    const value =
      att.isWriteOnly && canRegisterProviderFeatureUsage
        ? `this.markWriteOnlyAttribute(${mappedValue})`
        : mappedValue;

    this.code.line(`${att.terraformName}: ${value},`);
  }
}
