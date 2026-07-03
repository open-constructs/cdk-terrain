// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { logger } from "@cdktn/commons";
import { resolveStoredClassName } from "../../generator/models/supported-stored-classes";
import {
  AttributeModel,
  AttributeTypeModel,
  MapAttributeTypeModel,
} from "../../generator/models";

describe("resolveStoredClassName", () => {
  test("own composed name resolves as-is when supported (not collapsed)", () => {
    expect(resolveStoredClassName("stringListMap", "list")).toEqual({
      name: "StringListMap",
      collapsed: false,
    });
    expect(resolveStoredClassName("stringMapMap", "map")).toEqual({
      name: "StringMapMap",
      collapsed: false,
    });
    expect(resolveStoredClassName("numberMapMap", "map")).toEqual({
      name: "NumberMapMap",
      collapsed: false,
    });
    expect(resolveStoredClassName("booleanMapMap", "map")).toEqual({
      name: "BooleanMapMap",
      collapsed: false,
    });
  });

  test("unsupported own composed name collapses to nearest Any-wrapper", () => {
    // map(map(list(string))) - own "stringListMapMap" unsupported, element is a map
    expect(resolveStoredClassName("stringListMapMap", "map")).toEqual({
      name: "AnyMapMap",
      collapsed: true,
    });
    // list(map(map(string))) - own "stringMapMapList" unsupported, element is a map
    expect(resolveStoredClassName("stringMapMapList", "map")).toEqual({
      name: "AnyMapList",
      collapsed: true,
    });
    // set(map(list(number))) - own "numberListMapList" unsupported, element is a map
    expect(resolveStoredClassName("numberListMapList", "map")).toEqual({
      name: "AnyMapList",
      collapsed: true,
    });
    // map(map(map(list(string)))) - own "stringListMapMapMap" unsupported, element is a map
    expect(resolveStoredClassName("stringListMapMapMap", "map")).toEqual({
      name: "AnyMapMap",
      collapsed: true,
    });
  });

  test("returns undefined when neither the own name nor a collapsed Any-wrapper exists", () => {
    // Own name doesn't end in List/Map at all.
    expect(resolveStoredClassName("somethingWeird", "map")).toBeUndefined();
    // Own name ends in Map, but the element isn't itself a list/set/map, so there is no
    // "AnyXMap" candidate to fall back to.
    expect(resolveStoredClassName("weirdMap", "struct")).toBeUndefined();
    expect(resolveStoredClassName("weirdMap", "simple")).toBeUndefined();
  });
});

// A minimal stand-in for a non-complex, non-collection AttributeTypeModel whose
// typeModelType is neither "list", "set", "map", nor "simple"/"struct" - i.e. a shape the
// generator's collapse logic has no candidate class name for. Used to exercise the
// defensive plain-getter fallback in AttributeModel.getterType without needing a real
// (currently nonexistent) unsupported shape.
class UnresolvableStubTypeModel implements AttributeTypeModel {
  get struct() {
    return undefined;
  }
  get isComplex() {
    return false;
  }
  getStoredClassInitializer(_name: string) {
    return "";
  }
  get storedClassType() {
    return "unresolvable";
  }
  get inputTypeDefinition() {
    return "any";
  }
  getAttributeAccessFunction(name: string) {
    return `this.interpolationForAttribute('${name}')`;
  }
  get toTerraformFunction() {
    return "cdktn.anyToTerraform";
  }
  get toHclTerraformFunction() {
    return "cdktn.anyToHclTerraform";
  }
  get typeModelType() {
    return "unresolvable-shape";
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

describe("AttributeModel.getterType loud fallback", () => {
  test("falls back to a plain getter and logs a debug breadcrumb when no stored class (not even a collapsed Any-wrapper) is available", () => {
    const debugSpy = jest.spyOn(logger, "debug").mockImplementation();

    try {
      // A map whose element is itself an unrecognized shape: own composed name
      // ("unresolvableMap") isn't in the supported set, and the element's typeModelType
      // isn't "list"/"set"/"map", so there is no "AnyXMap" candidate either.
      const type = new MapAttributeTypeModel(new UnresolvableStubTypeModel());
      expect(type.isStoredClassUnavailable).toBe(true);

      const attribute = new AttributeModel({
        storageName: "_weirdAttribute",
        name: "weirdAttribute",
        type,
        optional: false,
        computed: true,
        terraformName: "weird_attribute",
        terraformFullName: "test_resource.weird_attribute",
        provider: false,
        required: false,
      });

      expect(attribute.getterType).toEqual({ _type: "plain" });
      expect(attribute.storedClassBoundaryKind).toEqual("fallback");

      expect(debugSpy).toHaveBeenCalledTimes(1);
      const [message] = debugSpy.mock.calls[0];
      expect(message).toContain("test_resource.weird_attribute");
      expect(message).toContain("unresolvableMap");

      // Repeated access must not spam the logger.
      void attribute.getterType;
      void attribute.getterType;
      expect(debugSpy).toHaveBeenCalledTimes(1);
    } finally {
      debugSpy.mockRestore();
    }
  });
});
