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
    const comment = sanitizedComment(this.code);
    comment.line(`@param providerLocalName ${PROVIDER_LOCAL_NAME_JSDOC}`);
    comment.end();
    this.code.openBlock(
      `constructor(private readonly providerLocalName: string)`,
    );
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
    for (const param of fn.parameters) {
      comment.line(
        `@param {${param.docstringType}} ${param.name} ${param.description ?? ""}`.trimEnd(),
      );
    }
    if (fn.variadicParameter) {
      const param = fn.variadicParameter;
      comment.line(
        `@param {Array<${param.docstringType}>} ${param.name} ${param.description ?? ""}`.trimEnd(),
      );
    }
    comment.end();

    const methodParams = [
      ...fn.parameters.map(
        (p) => `${p.name}${p.optional ? "?" : ""}: ${p.tsType}`,
      ),
      ...(fn.variadicParameter
        ? [`${fn.variadicParameter.name}: ${fn.variadicParameter.tsType}[]`]
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
