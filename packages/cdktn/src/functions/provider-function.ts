// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { IResolvable } from "../tokens/resolvable";
import { anyValue, terraformFunction, variadic } from "./helpers";
import { recordProviderFunctionUsage } from "./usage-registry";

/**
 * Runtime entry point invoked by generated provider function bindings
 * (`providers/<provider>/provider-functions/index.ts`). Generated code only
 * imports the public `cdktn` package root, so this is the single chokepoint
 * through which every provider-defined function call flows.
 */
export class TerraformProviderFunction {
  /**
   * Invokes a provider-defined function (Terraform's
   * `provider::<providerLocalName>::<functionName>(...)` syntax).
   *
   * @param providerLocalName the local name of the provider as declared in
   * `required_providers` (defaults to the registry short name; callers may
   * override this when the provider is aliased under a different local
   * name — aliases do not change the namespace, local names do)
   * @param functionName the provider-defined function name (snake_case, as
   * published in the provider schema)
   * @param args the function arguments, in declared order
   */
  public static invoke(
    providerLocalName: string,
    functionName: string,
    args: any[],
  ): IResolvable {
    const fullName = `provider::${providerLocalName}::${functionName}`;
    recordProviderFunctionUsage(fullName);
    // terraformFunction() also records `fullName` into the `Fn` usage
    // registry (usedFunctions); this is harmless since
    // ValidateFunctionVersionSupport only checks names present in its own
    // functionVersionConstraints map, which provider functions never are.
    return terraformFunction(fullName, [variadic(anyValue)])(args);
  }

  private constructor() {}
}
