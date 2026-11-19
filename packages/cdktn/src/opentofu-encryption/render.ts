// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from "constructs";
import { resolve } from "../_tokens";
import { Tokenization } from "../tokens/token";
import { isKeyProvider, OpenTofuKeyProvider } from "./key-provider";
import type { OpenTofuEncryptionMethod } from "./method";
import type {
  OpenTofuEncryptionRemoteStateTarget,
  OpenTofuEncryptionTarget,
} from "./opentofu-encryption";

const TRAVERSAL = Symbol("traversal");

// A reference such as `method.aes_gcm.main`, which OpenTofu only accepts as a bare traversal, never as `${...}`
interface Traversal {
  readonly [TRAVERSAL]: string;
}

export interface Block {
  readonly type: string;
  readonly labels: string[];
  readonly attributes: { [key: string]: any };
  readonly blocks: Block[];
}

// The root and first attribute of each traversal in a template's `${...}` and `%{...}` sequences
const EXPRESSION_REFERENCE =
  /(?<![\w.)\]-])([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)/g;

// The variables a `for` expression or `%{ for }` directive declares, e.g. `key, val` in `[for key, val in ...]`
const FOR_VARIABLES =
  /(?<![\w.-])for\s+([A-Za-z_][\w-]*)(?:\s*,\s*([A-Za-z_][\w-]*))?\s+in(?![\w-])/g;

const IGNORED_REFERENCE_ROOTS = ["path", "terraform"];

/**
 * Finds the references, such as `var.passphrase`, in the expressions of a block's attribute values.
 * @param block - the block
 * @returns the references, as root and first attribute
 */
export function references(block: Block): string[] {
  const found = new Set<string>();
  const visit = (value: any): void => {
    if (typeof value === "string") {
      // quoted strings inside an expression aren't references
      const code = templateSegments(value)
        .filter((segment) => segment.code)
        .map((segment) => segment.text.replace(/"(?:[^"\\]|\\.)*"/g, '""'))
        .join(" ");
      const scopes = forScopes(code);
      for (const match of code.matchAll(EXPRESSION_REFERENCE)) {
        const [, root, attribute] = match;
        const index = match.index!;
        const declared = scopes.some(
          (scope) =>
            scope.start <= index &&
            index < scope.end &&
            scope.names.includes(root),
        );
        if (!declared && !IGNORED_REFERENCE_ROOTS.includes(root)) {
          found.add(`${root}.${attribute}`);
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (isPlainObject(value)) {
      Object.values(value).forEach(visit);
    }
  };
  visit(block.attributes);
  block.blocks.forEach((child) =>
    references(child).forEach((r) => found.add(r)),
  );
  return [...found];
}

const FOR_DIRECTIVE = /%\{~?\s*(for|endfor)(?![\w-])/g;

/**
 * Finds where the variables of each `for` expression and `%{ for }` directive are in scope: from the `:` to the
 * closing bracket of an expression, and from the end of a directive to its `%{ endfor }`.
 * @param code - the template's code, with quoted strings emptied
 * @returns the scopes, as variable names and a range of indices
 */
function forScopes(
  code: string,
): { names: string[]; start: number; end: number }[] {
  const scopes: { names: string[]; start: number; end: number }[] = [];
  for (const match of code.matchAll(FOR_VARIABLES)) {
    const names = [match[1], match[2]].filter((name) => name !== undefined);
    const before = code.slice(0, match.index).trimEnd();
    const after = match.index! + match[0].length;
    if (/%\{~?$/.test(before)) {
      scopes.push({
        names,
        start: closingBracket(code, before.lastIndexOf("{")),
        end: endForDirective(code, after),
      });
    } else if (before.endsWith("[") || before.endsWith("{")) {
      const close = closingBracket(code, before.length - 1);
      scopes.push({ names, start: bodyStart(code, after, close), end: close });
    }
  }
  return scopes;
}

/**
 * Finds the bracket that closes the one at `open`.
 * @param code - the code
 * @param open - the index of a `(`, `[` or `{`
 * @returns the index of the closing bracket, or the code's length if it isn't closed
 */
function closingBracket(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if ("([{".includes(code[i])) depth++;
    else if (")]}".includes(code[i]) && --depth === 0) return i;
  }
  return code.length;
}

/**
 * Finds the `:` that starts a `for` expression's body, skipping those of conditionals in its collection.
 * @param code - the code
 * @param from - the index after the expression's `in`
 * @param close - the index of the expression's closing bracket
 * @returns the index of the `:`, or `from` if there isn't one
 */
function bodyStart(code: string, from: number, close: number): number {
  let depth = 0;
  let conditionals = 0;
  for (let i = from; i < close; i++) {
    const c = code[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === "?") conditionals++;
    else if (depth === 0 && c === ":" && conditionals-- === 0) return i;
  }
  return from;
}

/**
 * Finds the `%{ endfor }` that closes a `%{ for }` directive.
 * @param code - the code
 * @param from - an index inside the `%{ for }` directive
 * @returns the index of the `%{ endfor }`, or the code's length if there isn't one
 */
function endForDirective(code: string, from: number): number {
  let depth = 1;
  for (const match of code.slice(from).matchAll(FOR_DIRECTIVE)) {
    depth += match[1] === "for" ? 1 : -1;
    if (depth === 0) return from + match.index!;
  }
  return code.length;
}

/**
 * Splits a template string into literal text and the `${...}` interpolations and `%{...}` directives that hold
 * code. `$${` and `%%{` are escaped literal `${` and `%{`.
 * @param str - the string
 * @returns the segments, in order
 */
function templateSegments(str: string): { text: string; code: boolean }[] {
  const segments: { text: string; code: boolean }[] = [];
  let literal = "";
  let i = 0;
  while (i < str.length) {
    if (str.startsWith("$${", i) || str.startsWith("%%{", i)) {
      literal += str.slice(i, i + 3);
      i += 3;
    } else if (str.startsWith("${", i) || str.startsWith("%{", i)) {
      const end = codeEnd(str, i + 2);
      if (end === -1) {
        literal += str.slice(i);
        break;
      }
      if (literal) segments.push({ text: literal, code: false });
      segments.push({ text: str.slice(i, end + 1), code: true });
      literal = "";
      i = end + 1;
    } else {
      literal += str[i];
      i += 1;
    }
  }
  if (literal) segments.push({ text: literal, code: false });
  return segments;
}

/**
 * Finds the `}` that closes an interpolation or directive, skipping nested braces and quoted strings.
 * @param str - the string
 * @param start - the index after the opening `${` or `%{`
 * @returns the index of the closing `}`, or -1 if it isn't closed
 */
function codeEnd(str: string, start: number): number {
  let depth = 1;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (c === '"') {
      for (i++; i < str.length && str[i] !== '"'; i++) {
        if (str[i] === "\\") i++;
      }
    } else if (c === "{") {
      depth++;
    } else if (c === "}" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Renders a string as an HCL quoted template. Literal text is escaped; `${...}` and `%{...}` sequences are HCL
 * already, so escaping the quotes inside them would break them.
 * @param str - the string, e.g. a resolved token such as `${file("pass.txt")}`
 * @returns the quoted template
 */
function renderHclString(str: string): string {
  const body = templateSegments(str)
    .map(({ text, code }) => (code ? text : escapeHclLiteral(text)))
    .join("");
  return `"${body}"`;
}

const HCL_ESCAPES: { [char: string]: string } = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/**
 * Escapes literal text for an HCL quoted template, including control characters, which HCL doesn't accept raw.
 * @param text - the text
 * @returns the escaped text
 */
function escapeHclLiteral(text: string): string {
  return Array.from(text, (c) => {
    if (HCL_ESCAPES[c]) return HCL_ESCAPES[c];
    const code = c.charCodeAt(0);
    return code < 0x20 || code === 0x7f
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : c;
  }).join("");
}

/**
 * Finds the key providers that a key provider's or method's attributes reference.
 * @param value - the attributes, or part of them
 * @returns the key providers
 */
export function keyProvidersIn(value: any): OpenTofuKeyProvider[] {
  if (isKeyProvider(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(keyProvidersIn);
  if (isPlainObject(value)) {
    return Object.values(value).flatMap(keyProvidersIn);
  }
  return [];
}

/**
 * Builds a reference to a key provider or method.
 * @param kind - what the reference points to
 * @param ref - the key provider or method
 * @returns the reference
 */
function traversal(
  kind: "key_provider" | "method",
  ref: { readonly type: string; readonly name: string },
): Traversal {
  return { [TRAVERSAL]: `${kind}.${ref.type}.${ref.name}` };
}

/**
 * Checks whether the value is a reference built by {@link traversal}.
 * @param value - any value
 * @returns true for a reference
 */
function isTraversal(value: any): value is Traversal {
  return typeof value === "object" && value !== null && TRAVERSAL in value;
}

/**
 * Checks whether the value is an object other than an array, a reference, a key provider or a token.
 * @param value - any value
 * @returns true for a plain object
 */
function isPlainObject(value: any): value is { [key: string]: any } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isTraversal(value) &&
    !isKeyProvider(value) &&
    !Tokenization.isResolvable(value)
  );
}

/**
 * Resolves the tokens in a key provider's or method's attributes, and turns key providers into references.
 * @param scope - the scope to resolve tokens in
 * @param value - the attributes, or part of them
 * @returns the resolved value
 */
function resolveAttribute(scope: Construct, value: any): any {
  if (isKeyProvider(value)) return traversal("key_provider", value);
  if (Array.isArray(value)) return value.map((v) => resolveAttribute(scope, v));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, resolveAttribute(scope, v)]),
    );
  }
  return resolve(scope, value);
}

/**
 * Builds the `key_provider` or `method` block declaring a key provider or method.
 * @param scope - the scope to resolve tokens in
 * @param kind - the block type
 * @param element - the key provider or method
 * @returns the block
 */
export function declarationBlock(
  scope: Construct,
  kind: "key_provider" | "method",
  element: OpenTofuKeyProvider | OpenTofuEncryptionMethod,
): Block {
  return {
    type: kind,
    labels: [element.type, element.name],
    attributes: resolveAttribute(scope, element._config),
    blocks: [],
  };
}

/**
 * Builds the block of a target, e.g. `state`.
 * @param type - the block type
 * @param labels - the block labels
 * @param target - the target
 * @returns the block
 */
export function targetBlock(
  type: string,
  labels: string[],
  target: OpenTofuEncryptionTarget | OpenTofuEncryptionRemoteStateTarget,
): Block {
  const attributes: { [key: string]: any } = {
    method: traversal("method", target.method),
  };
  if ("enforced" in target && target.enforced !== undefined) {
    attributes.enforced = target.enforced;
  }
  const blocks: Block[] = target.fallback
    ? [
        {
          type: "fallback",
          labels: [],
          attributes: { method: traversal("method", target.fallback) },
          blocks: [],
        },
      ]
    : [];
  return { type, labels, attributes, blocks };
}

/**
 * Converts references to the bare strings Terraform JSON configuration expects.
 * @param value - an attribute value
 * @returns the JSON value
 */
function toJsonValue(value: any): any {
  if (isTraversal(value)) return value[TRAVERSAL];
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toJsonValue(v)]),
    );
  }
  return value;
}

/**
 * Renders a block's content as Terraform JSON configuration, nesting labelled blocks by type and labels.
 * @param block - the block
 * @returns the JSON object
 */
export function blockToJson(block: Block): { [key: string]: any } {
  const json = toJsonValue(block.attributes);
  for (const child of block.blocks) {
    const path = [child.type, ...child.labels];
    let parent = json;
    for (const key of path.slice(0, -1)) {
      parent = parent[key] ??= {};
    }
    parent[path[path.length - 1]] = blockToJson(child);
  }
  return json;
}

/**
 * Renders a block as HCL.
 * @param block - the block
 * @param indent - the block's indentation
 * @returns the block's lines
 */
export function blockToHcl(block: Block, indent: string): string[] {
  const header = [block.type, ...block.labels.map((l) => JSON.stringify(l))];
  const inner = `${indent}  `;
  const lines = [
    ...Object.entries(block.attributes).map(
      ([key, value]) => `${inner}${key} = ${renderHclExpression(value)}`,
    ),
    ...block.blocks.flatMap((child) => blockToHcl(child, inner)),
  ];
  if (lines.length === 0) return [`${indent}${header.join(" ")} {}`];
  return [`${indent}${header.join(" ")} {`, ...lines, `${indent}}`];
}

/**
 * Renders an attribute value as an HCL expression.
 * @param value - the value
 * @returns the expression
 */
function renderHclExpression(value: any): string {
  if (isTraversal(value)) return value[TRAVERSAL];
  if (Array.isArray(value)) {
    return `[${value.map(renderHclExpression).join(", ")}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).map(
      ([k, v]) => `${JSON.stringify(k)} = ${renderHclExpression(v)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  if (typeof value === "string") return renderHclString(value);
  return JSON.stringify(value);
}
