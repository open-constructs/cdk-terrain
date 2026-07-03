// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { uppercaseFirst } from "../../../util";

// The core cdktn package (packages/cdktn/src/complex-computed-list.ts) only hand-writes
// this fixed set of wrapper classes for computed, non-complex collection attributes.
// Arbitrarily deep nestings of list/set/map (e.g. map(map(list(string)))) compose a
// storedClassType (e.g. "stringListMapMap") that has no corresponding class. Rather than
// falling back straight to a plain, untyped getter, resolveStoredClassName below first
// looks for the nearest typed "Any"-wrapper that still exists in this set, collapsing the
// unsupported inner shape into an untyped boundary while preserving typed navigation for
// the outer layers (see https://github.com/open-constructs/cdk-terrain/issues/11).
const SUPPORTED_STORED_CLASSES = new Set([
  "StringMap",
  "NumberMap",
  "BooleanMap",
  "AnyMap",
  "StringMapMap",
  "NumberMapMap",
  "BooleanMapMap",
  "AnyMapMap",
  "BooleanList",
  "StringListList",
  "NumberListList",
  "BooleanListList",
  "AnyListList",
  "StringMapList",
  "NumberMapList",
  "BooleanMapList",
  "AnyMapList",
  "StringListMap",
  "NumberListMap",
  "BooleanListMap",
  "AnyListMap",
]);

// Resolves the composed stored class name to use for a collection attribute (list/set/map)
// whose element is itself a non-complex collection (or simple type).
//
// `ownStoredClassType` is this type's own composed storedClassType (e.g. "stringListMapMap"
// for map(map(list(string)))) and `elementTypeModelType` is the element's typeModelType
// ("list" | "set" | "map" | "simple" | ...).
//
// Resolution order:
//   1. The own composed name (e.g. "StringListMapMap") - used as-is when it refers to a
//      class that is hand-written in the core package (not collapsed).
//   2. Otherwise, the nearest typed "Any"-wrapper that still encodes the outer two layers
//      (this type's own layer and its element's layer), e.g. "AnyMapMap" - collapsing the
//      unsupported inner shape into an untyped boundary while preserving typed navigation
//      for the outer layers.
//   3. Otherwise (defensively; every depth should resolve via 1 or 2), undefined - the
//      caller must fall back to a plain, untyped getter.
export function resolveStoredClassName(
  ownStoredClassType: string,
  elementTypeModelType: string,
): { name: string; collapsed: boolean } | undefined {
  const candidate1 = uppercaseFirst(ownStoredClassType);
  if (SUPPORTED_STORED_CLASSES.has(candidate1)) {
    return { name: candidate1, collapsed: false };
  }

  let ownLayer: "List" | "Map" | undefined;
  if (ownStoredClassType.endsWith("List")) {
    ownLayer = "List";
  } else if (ownStoredClassType.endsWith("Map")) {
    ownLayer = "Map";
  }
  if (!ownLayer) {
    return undefined;
  }

  let innerLayer: "List" | "Map" | undefined;
  if (elementTypeModelType === "list" || elementTypeModelType === "set") {
    innerLayer = "List";
  } else if (elementTypeModelType === "map") {
    innerLayer = "Map";
  }
  if (!innerLayer) {
    return undefined;
  }

  const candidate2 = `Any${innerLayer}${ownLayer}`;
  if (SUPPORTED_STORED_CLASSES.has(candidate2)) {
    return { name: candidate2, collapsed: true };
  }

  return undefined;
}
