// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

// Matches a named value import: `import { A, B as C } from "module";`
// Type-only imports (`import type { ... }`) are left alone.
const NAMED_IMPORT =
  /import\s+(?!type\b)\{([^}]*)\}\s*from\s*(["'])([^"']+)\2;?/g;

const normalizeSpecifier = (specifier: string) =>
  specifier.trim().replace(/\s+/g, " ");

function namedImportsOf(source: string): Set<string> {
  const imported = new Set<string>();
  for (const match of source.matchAll(NAMED_IMPORT)) {
    const [, specifiers, , moduleName] = match;
    specifiers
      .split(",")
      .map(normalizeSpecifier)
      .filter(Boolean)
      .forEach((specifier) => imported.add(`${moduleName}\0${specifier}`));
  }
  return imported;
}

/**
 * Removes named imports from `generatedImports` that `inputFile` already has
 * (same specifier from the same module), so that prepending the generated
 * imports to the file does not declare an identifier twice (TS2300).
 * An import statement whose specifiers are all present is dropped.
 */
export function mergeImports(generatedImports: string, inputFile: string) {
  const existing = namedImportsOf(inputFile);
  if (existing.size === 0) {
    return generatedImports;
  }

  return generatedImports.replace(
    NAMED_IMPORT,
    (statement, specifiers: string, _quote, moduleName: string) => {
      const all = specifiers.split(",").map(normalizeSpecifier).filter(Boolean);
      const missing = all.filter(
        (specifier) => !existing.has(`${moduleName}\0${specifier}`),
      );

      if (missing.length === all.length) {
        return statement;
      }
      if (missing.length === 0) {
        return "";
      }
      return `import { ${missing.join(", ")} } from "${moduleName}";`;
    },
  );
}
