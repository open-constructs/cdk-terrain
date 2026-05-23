// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import camelcase from "camelcase";

export { logger } from "@cdktn/commons";

export const leaveCommentText = `Please leave a comment at https://github.com/hashicorp/terraform-cdk/issues/842 if you run into this issue.`;

export const camelCase = (str: string) => camelcase(str.replace(/[-/]/g, "_"));
export const pascalCase = (str: string) =>
  camelcase(str.replace(/[-/]/g, "_"), { pascalCase: true });

export function uniqueId(set: Set<string>, key: string): string {
  if (set.has(key)) {
    return uniqueId(set, `${key}_${set.size}`);
  }
  set.add(key);
  return key;
}
