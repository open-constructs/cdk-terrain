// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { CUSTOM_DEFAULTS } from "./custom-defaults";
import { AttributeModel } from "./models/attribute-model";
import { structTypeModelOf } from "./models/attribute-type-model";
import { Struct } from "./models/struct";

/**
 * Merges structurally identical structs inside one resource.
 *
 * `detectAttributeLoops` only collapses a shape that repeats among its own
 * ancestors; identical shapes on sibling branches are never compared. This
 * closes that gap.
 *
 * Equality is a full recursive signature, deliberately NOT
 * `getAttributeIdentifier` from loop-detection: that compares one level of
 * nesting and, applied resource-wide, merges structs that diverge deeper,
 * emitting incorrect bindings.
 */

function defaultOf(attr: AttributeModel): string {
  return attr.terraformFullName in CUSTOM_DEFAULTS
    ? `=${JSON.stringify(CUSTOM_DEFAULTS[attr.terraformFullName])}`
    : "";
}

function signature(struct: Struct, stack: Struct[]): string {
  // A struct already on the stack is a cycle (introduced by loop detection).
  // Encode how far up it points so equivalent cyclic shapes agree.
  const back = stack.indexOf(struct);
  if (back !== -1) return `@rec:${stack.length - back}`;

  stack.push(struct);
  const parts = struct.attributes
    .map((a) => {
      const holder = structTypeModelOf(a.type);
      const inner = holder
        ? signature(holder.struct, stack)
        : a.type.storedClassType;
      // Everything that changes what is emitted for the attribute (`required`
      // follows from optional/computed). typeModelType distinguishes
      // list/set/map wrappers around one shape.
      return [
        a.terraformName,
        a.optional ? "?" : "",
        a.computed ? "c" : "",
        a.isWriteOnly ? "wo" : "",
        a.type.typeModelType,
        "isBlock" in a.type && a.type.isBlock ? "block" : "",
        defaultOf(a),
        inner,
      ].join(":");
    })
    .sort();
  stack.pop();

  // Flags that change what is emitted for an otherwise identical shape
  const flags = [
    struct.isClass ? "class" : "",
    struct.isAnonymous ? "anon" : "",
    struct.isSingleItem ? "single" : "",
    struct.nestingMode,
  ].join(",");

  return `{${parts.join("|")}}<${flags}>`;
}

function collect(attributes: AttributeModel[], found: Set<Struct>): void {
  for (const attr of attributes) {
    const struct = structTypeModelOf(attr.type)?.struct;
    if (!struct) continue;
    if (found.has(struct)) continue; // also guards recursive structs
    found.add(struct);
    collect(struct.attributes, found);
  }
}

function repoint(
  attributes: AttributeModel[],
  canonical: Map<Struct, Struct>,
  seen: Set<Struct>,
): void {
  for (const attr of attributes) {
    const holder = structTypeModelOf(attr.type);
    if (!holder) continue;
    // every emitted name derives from `struct`
    const target = canonical.get(holder.struct);
    if (target) holder.struct = target;
    const struct = holder.struct;
    if (seen.has(struct)) continue;
    seen.add(struct);
    repoint(struct.attributes, canonical, seen);
  }
}

/** @returns structs that are no longer referenced. */
export function deduplicateStructs(attributes: AttributeModel[]): Set<Struct> {
  const all = new Set<Struct>();
  collect(attributes, all);

  const bySignature = new Map<string, Struct[]>();
  for (const struct of all) {
    const sig = signature(struct, []);
    const bucket = bySignature.get(sig);
    if (bucket) bucket.push(struct);
    else bySignature.set(sig, [struct]);
  }

  const canonical = new Map<Struct, Struct>();
  const removed = new Set<Struct>();
  for (const bucket of bySignature.values()) {
    if (bucket.length < 2) continue;
    // PLACEHOLDER NAMING: shortest name, lexicographic tie-break. Not stable
    // across provider releases; the shape -> name registry is the fix.
    const winner = [...bucket].sort(
      (a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name),
    )[0];
    for (const struct of bucket) {
      canonical.set(struct, winner);
      if (struct !== winner) removed.add(struct);
    }
  }

  repoint(attributes, canonical, new Set());
  return removed;
}
