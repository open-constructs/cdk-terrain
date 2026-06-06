/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import nx from "@nx/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-plugin-prettier/recommended";

export const baseConfig = [
  ...nx.configs["flat/base"],
  {
    ignores: [
      "**/node_modules",
      "**/dist",
      "**/coverage",
      "**/.corepack-cache/**",
      "**/*.d.ts",
      "**/*.js",
      "**/*.mjs",
      "**/.gen/**",
      "packages/@cdktn/provider-generator/edge-provider-bindings/providers/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],

    languageOptions: {
      parser: tsParser,
    },

    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          enforceBuildableLibDependency: true,
          allow: ["^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$"],
          depConstraints: [
            {
              sourceTag: "*",
              onlyDependOnLibsWithTags: ["*"],
            },
          ],
        },
      ],

      "@typescript-eslint/no-explicit-any": 0,
      "@typescript-eslint/explicit-function-return-type": 0,
      "@typescript-eslint/no-use-before-define": 0,
      "@typescript-eslint/explicit-module-boundary-types": 0,
      "@typescript-eslint/no-var-requires": 0,
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "no-sequences": "error",
      "no-unused-vars": "off",
      "prefer-const": "warn",
      "no-useless-escape": "warn",

      "no-irregular-whitespace": [
        "error",
        {
          skipTemplates: true,
        },
      ],
    },
  },
];

export default [...baseConfig, prettierConfig];
