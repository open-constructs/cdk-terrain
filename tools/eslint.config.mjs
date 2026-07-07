/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

// The root config ignores all **/*.js and **/*.mjs, so the loose scripts in
// this directory would otherwise go unlinted. Lint them as plain ESM Node
// scripts; the nested tools/* projects own their own files.

import eslint from "@eslint/js";
import globals from "globals";
import prettierConfig from "eslint-plugin-prettier/recommended";

export default [
  {
    ignores: ["documentation-generation/**", "generate-function-bindings/**"],
  },
  eslint.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "prefer-const": "warn",
    },
  },
  prettierConfig,
];
