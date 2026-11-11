// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Tokenization, DefaultTokenResolver, StringConcat } from "./tokens";
import { Construct } from "constructs";

const TOKEN_RESOLVER = new DefaultTokenResolver(new StringConcat());

/**
 * Resolves all tokens in an object using the default token resolver
 * @param scope The construct the tokens are resolved in
 * @param obj The object to resolve
 * @param preparing Whether this is the preparation pass rather than the final resolution
 * @returns The object with all tokens resolved
 */
export function resolve<T>(scope: Construct, obj: T, preparing = false): T {
  return Tokenization.resolve(obj, {
    scope,
    preparing,
    resolver: TOKEN_RESOLVER,
  });
}
