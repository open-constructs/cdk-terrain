// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { IResolvable } from "../tokens/resolvable";
import { anyValue, terraformFunction } from "./helpers";

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
   * Note: provider-defined functions are evaluated by the provider itself —
   * do not call this inside the configuration of the same provider
   * (Terraform reports a self-referential cycle).
   *
   * @param providerLocalName the local name of the provider as declared in
   * `required_providers` (defaults to the registry short name; callers may
   * override this when the provider is aliased under a different local
   * name — aliases do not change the namespace, local names do)
   * @param functionName the provider-defined function name (snake_case, as
   * published in the provider schema)
   * @param args the function arguments, positional (in declared order). Each
   * entry in `args` maps 1:1 to a positional slot in the rendered call — a
   * `null` or `undefined` entry keeps its slot and renders as the Terraform
   * `null` keyword, it is not dropped. Callers that flatten a genuinely
   * variadic trailing parameter (`[a, ...values]`) get one positional slot
   * per flattened element, which is the desired behavior.
   */
  public static invoke(
    providerLocalName: string,
    functionName: string,
    args: any[],
  ): IResolvable {
    const fullName = `provider::${providerLocalName}::${functionName}`;
    // Usage is recorded at token-resolve time (see FunctionCall.resolve() in
    // tfExpression.ts and usage-registry.ts), not here at call time: this
    // just builds the token that resolve() later records when it actually
    // renders into a stack.
    //
    // Note: intentionally NOT `[variadic(anyValue)]` - variadic()/listOf()
    // filters out null/undefined ENTRIES of the array, which is correct for
    // a genuinely variadic list but wrong here: `args` is a fixed-arity,
    // positional argument list where a `null`/`undefined` entry is a
    // meaningful value (e.g. Terraform's `condition_if(cond, null, "b")`),
    // not a hole to be squeezed out. Validating per-position with a plain
    // `anyValue` per slot (one validator per `args` element, by
    // construction the same length) preserves every slot, including
    // null/undefined ones.
    return terraformFunction(
      fullName,
      args.map(() => anyValue),
    )(...args);
  }

  private constructor() {}
}
