// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { AttributeModel } from "./models/attribute-model";
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

// Only StructAttributeTypeModel owns `struct`; collections expose it as a
// prototype getter onto their element type.
function structHolder(type: any): any | undefined {
  if (!type) return undefined;
  if (Object.prototype.hasOwnProperty.call(type, "struct") && type.struct) {
    return type;
  }
  if (type.elementType) return structHolder(type.elementType);
  return undefined;
}

function signature(struct: Struct, stack: Struct[]): string {
  // A struct already on the stack is a cycle (introduced by loop detection).
  // Encode how far up it points so equivalent cyclic shapes agree.
  const back = stack.indexOf(struct);
  if (back !== -1) return `@rec:${stack.length - back}`;

  const next = [...stack, struct];
  const parts = struct.attributes
    .map((a) => {
      const holder = structHolder(a.type);
      const inner = holder
        ? signature(holder.struct, next)
        : a.type.storedClassType;
      // typeModelType distinguishes list/set/map wrappers around one shape
      return [
        a.terraformName,
        a.optional ? "?" : "",
        a.computed ? "c" : "",
        a.type.typeModelType,
        inner,
      ].join(":");
    })
    .sort();

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
    const holder = structHolder(attr.type);
    if (!holder) continue;
    const struct: Struct = holder.struct;
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
    const holder = structHolder(attr.type);
    if (!holder) continue;
    const target = canonical.get(holder.struct);
    if (target && target !== holder.struct) {
      // readonly in TS only; every emitted name derives from `struct`
      holder.struct = target;
    }
    const struct: Struct = holder.struct;
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
