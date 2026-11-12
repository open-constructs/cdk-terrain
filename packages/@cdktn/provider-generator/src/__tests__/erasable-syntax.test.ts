// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as path from "path";
import * as ts from "typescript";
import { generateProviderBindingsFromSchema } from "..";
import { mkdtemp } from "@cdktn/commons";
import { edgeSchema } from "./edge-provider-schema";

// "This syntax is not allowed when 'erasableSyntaxOnly' is enabled."
const ERASABLE_SYNTAX_ERROR = 1294;
// "'X' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled."
const VERBATIM_MODULE_SYNTAX_ERROR = 1484;

function listTypescriptFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? listTypescriptFiles(path.join(dir, entry.name))
        : entry.name.endsWith(".ts")
          ? [path.join(dir, entry.name)]
          : [],
    );
}

function erasableSyntaxErrors(files: string[], baseDir: string): string[] {
  const program = ts.createProgram(files, {
    noEmit: true,
    noResolve: true,
    skipLibCheck: true,
    erasableSyntaxOnly: true,
    verbatimModuleSyntax: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  });
  return files
    .map((name) => program.getSourceFile(name))
    .filter((file): file is ts.SourceFile => file !== undefined)
    .flatMap((file) =>
      program
        .getSemanticDiagnostics(file)
        .filter(
          (diagnostic) =>
            diagnostic.code === ERASABLE_SYNTAX_ERROR ||
            diagnostic.code === VERBATIM_MODULE_SYNTAX_ERROR,
        )
        .map((diagnostic) => {
          const { line } = file.getLineAndCharacterOfPosition(
            diagnostic.start ?? 0,
          );
          return `${path.relative(baseDir, file.fileName)}:${line + 1}`;
        }),
    );
}

describe("generated provider bindings", () => {
  it("detects syntax that Node type stripping cannot erase", () =>
    mkdtemp(async (dir) => {
      const file = path.join(dir, "parameter-property.ts");
      fs.writeFileSync(
        file,
        "export class A { constructor(private readonly value: string) {} }\n",
      );

      expect(erasableSyntaxErrors([file], dir)).toEqual([
        "parameter-property.ts:1",
      ]);
    }));

  it("only uses syntax that Node type stripping can erase", () =>
    mkdtemp(async (dir) => {
      await generateProviderBindingsFromSchema(dir, edgeSchema);

      const providerDir = path.join(dir, "providers", "edge");
      const files = listTypescriptFiles(providerDir);

      expect(files.length).toBeGreaterThan(0);
      expect(erasableSyntaxErrors(files, providerDir)).toEqual([]);
    }));
});
