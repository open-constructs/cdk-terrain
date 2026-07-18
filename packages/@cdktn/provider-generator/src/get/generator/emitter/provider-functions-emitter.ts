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

const SELF_REFERENCE_CYCLE_JSDOC =
  "Note: provider-defined functions are evaluated by the provider itself — do not call this inside the configuration of the same provider (Terraform reports a self-referential cycle).";

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

    for (const fn of model.functions) {
      this.emitMethod(model.providerName, fn);
    }

    this.code.closeBlock();
  }

  private emitMethod(providerName: string, fn: ProviderFunctionModel) {
    this.code.line();

    const comment = sanitizedComment(this.code);
    const description = fn.description ?? fn.summary;
    if (description) comment.line(description);
    if (fn.deprecationMessage) {
      comment.line(`@deprecated ${fn.deprecationMessage}`);
    }
    comment.line(SELF_REFERENCE_CYCLE_JSDOC);
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
    comment.line(`@param providerLocalName ${PROVIDER_LOCAL_NAME_JSDOC}`);
    comment.end();

    const methodParams = [
      ...fn.parameters.map(
        (p) => `${p.name}${p.optional ? "?" : ""}: ${p.tsType}`,
      ),
      ...(fn.variadicParameter
        ? [`${fn.variadicParameter.name}: ${fn.variadicParameter.tsType}[]`]
        : []),
      `providerLocalName?: string`,
    ];

    const invokeArgs = [
      ...fn.parameters.map((p) => p.name),
      ...(fn.variadicParameter ? [`...${fn.variadicParameter.name}`] : []),
    ];

    const invokeExpression = `cdktn.TerraformProviderFunction.invoke(providerLocalName ?? "${providerName}", "${fn.terraformName}", [${invokeArgs.join(", ")}])`;

    this.code.openBlock(
      `public static ${fn.methodName}(${methodParams.join(", ")}): ${fn.returnTsType}`,
    );
    this.code.line(`return ${fn.wrapReturn(invokeExpression)};`);
    this.code.closeBlock();
  }
}
