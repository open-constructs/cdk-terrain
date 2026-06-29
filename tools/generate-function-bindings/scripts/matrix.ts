// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

// Shared types and location of the Terraform/OpenTofu function availability
// matrix maintained in function-availability/functions-matrix.json.

import * as path from "path";

export const FUNCTIONS_MATRIX_FILE = path.resolve(
  __dirname,
  "..",
  "function-availability",
  "functions-matrix.json",
);

export type ProductName = "terraform" | "opentofu";

export interface ProductAvailability {
  /** first stable version in which the function is present */
  introduced: string;
  /** first version in which a previously present function is absent */
  removed: string | null;
  /** versions between introduced/removed in which the function was absent */
  gaps: string[];
  /** number of scanned versions in which the function is present */
  count: number;
}

export interface FunctionMatrixEntry {
  signature: {
    description: string;
    return_type: unknown;
    parameters: unknown[];
    variadic_parameter: unknown | null;
  };
  products: Record<ProductName, ProductAvailability | null>;
}

export interface FunctionsMatrix {
  generated_note: string;
  versions: Record<ProductName, string[]>;
  functions: Record<string, FunctionMatrixEntry>;
}
