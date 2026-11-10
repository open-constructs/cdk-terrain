/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

/**
 * Serializes an object key fragment as the inner content of a Terraform
 * quoted-string literal, without the surrounding quotes.
 *
 * `JSON.stringify` covers quotes, backslashes and most control characters.
 * Terraform quoted strings reject the `\b` and `\f` escapes that JSON emits, so
 * those use four-digit Unicode escapes. `$${` and `%%{` are the Terraform
 * escapes for sequences that would otherwise start a template interpolation or
 * directive.
 *
 * Set `keepTemplates` when the fragment may hold a resolved token, which
 * renders as a `${...}` reference that must stay an interpolation.
 */
export function quotedStringKeyFragment(
  fragment: string,
  keepTemplates = false,
): string {
  // Replacer functions, not replacement strings: in a replacement string `$$`
  // is itself an escape for a literal `$` and would undo the escape below.
  const escaped = JSON.stringify(fragment)
    .slice(1, -1)
    .replace(/\\(\\|b|f)/g, (match, selector: string) =>
      selector === "b" ? "\\u0008" : selector === "f" ? "\\u000c" : match,
    );
  if (keepTemplates) {
    return escaped;
  }
  return escaped.replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{");
}

/**
 * Serializes an object key as a Terraform quoted-string literal.
 *
 * Set `keepTemplates` when the key may hold a resolved token, which renders as
 * a `${...}` reference that must stay an interpolation.
 */
export function quotedStringKey(key: string, keepTemplates = false): string {
  return `"${quotedStringKeyFragment(key, keepTemplates)}"`;
}
