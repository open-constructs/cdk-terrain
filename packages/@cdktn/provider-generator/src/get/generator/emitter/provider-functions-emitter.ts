// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { CodeMaker } from "codemaker";
import {
  ProviderFunctionModel,
  ProviderFunctionsModel,
} from "../models/provider-function-model";
import { sanitizedComment } from "../sanitized-comments";

const PROVIDER_LOCAL_NAME_JSDOC =
  "The local name of the provider in required_providers; defaults to the registry short name. Override when the provider is declared under a different local name — aliases do not change the namespace, local names do.";

export class ProviderFunctionsEmitter {
  constructor(private readonly code: CodeMaker) {}

  public emit(model: ProviderFunctionsModel) {
    this.code.line(`import * as cdktn from 'cdktn';`);
    this.code.line();
    this.emitClass(model);
  }

  private emitClass(model: ProviderFunctionsModel) {
    const comment = sanitizedComment(this.code);
    comment.line(
      `Provider-defined functions of the ${model.providerName} provider.`,
    );
    comment.end();
    this.code.openBlock(`export class ${model.className}`);

    this.emitConstructor();

    for (const fn of model.functions) {
      this.emitMethod(fn);
    }

    this.code.closeBlock();
  }

  private emitConstructor() {
    // A TypeScript parameter property (`constructor(private readonly x: T)`)
    // requires the compiler to synthesize a `this.x = x;` assignment - that's
    // a real transform, not a type-only erasure, so it isn't recognized by
    // Node's native type-stripping (`node file.ts` with no bundler/transpiler,
    // e.g. `--experimental-strip-types`), which throws
    // `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` on sight of one. Declare the field
    // and assign it in the constructor body instead, which strips cleanly.
    this.code.line(`private readonly providerLocalName: string;`);
    this.code.line();
    const comment = sanitizedComment(this.code);
    comment.line(`@param providerLocalName ${PROVIDER_LOCAL_NAME_JSDOC}`);
    comment.end();
    this.code.openBlock(`constructor(providerLocalName: string)`);
    this.code.line(`this.providerLocalName = providerLocalName;`);
    this.code.closeBlock();
  }

  private emitMethod(fn: ProviderFunctionModel) {
    this.code.line();

    const comment = sanitizedComment(this.code);
    const description = fn.description ?? fn.summary;
    if (description) comment.line(description);
    if (fn.deprecationMessage) {
      comment.line(`@deprecated ${fn.deprecationMessage}`);
    }
    // The variadic parameter's docstringType is already wrapped in
    // `Array<...>` by buildFunctionModel (see provider-function-model.ts),
    // so it shares this one `@param` emission path with every fixed
    // parameter instead of needing its own wrapping here.
    const allParameters = fn.variadicParameter
      ? [...fn.parameters, fn.variadicParameter]
      : fn.parameters;
    for (const param of allParameters) {
      // Official JSDoc grammar: only the type expression goes inside the
      // braces; prose (the schema description plus any generated
      // list/set/nullability guidance - see the model's `docstringNote`)
      // follows the parameter name after ` - `.
      const prose = [param.description, param.docstringNote]
        .filter(Boolean)
        .join(" ");
      comment.line(
        `@param {${param.docstringType}} ${param.name}${prose ? ` - ${prose}` : ""}`,
      );
    }
    comment.line(
      `@returns {${fn.returnDocstringType}}${fn.returnDocstringNote ? ` ${fn.returnDocstringNote}` : ""}`,
    );
    comment.end();

    const methodParams = [
      ...fn.parameters.map(
        (p) => `${p.name}${p.optional ? "?" : ""}: ${p.tsType}`,
      ),
      ...(fn.variadicParameter
        ? // `Array<T>` rather than `T[]`: for a union element type (e.g.
          // `boolean | cdktn.IResolvable`), bare `T[]` binds as `boolean |
          // (cdktn.IResolvable[])` instead of `(boolean | cdktn.IResolvable)[]`.
          [
            `${fn.variadicParameter.name}: Array<${fn.variadicParameter.tsType}>`,
          ]
        : []),
    ];

    const invokeArgs = [
      ...fn.parameters.map((p) => p.name),
      ...(fn.variadicParameter ? [`...${fn.variadicParameter.name}`] : []),
    ];

    const invokeExpression = `cdktn.TerraformProviderFunction.invoke(this.providerLocalName, "${fn.terraformName}", [${invokeArgs.join(", ")}])`;

    this.code.openBlock(
      `public ${fn.methodName}(${methodParams.join(", ")}): ${fn.returnTsType}`,
    );
    this.code.line(`return ${fn.wrapReturn(invokeExpression)};`);
    this.code.closeBlock();
  }
}
