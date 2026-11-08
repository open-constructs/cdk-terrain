/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import rootConfig from "../../eslint.config.mjs";
import jsdoc from "eslint-plugin-jsdoc";
import noInstanceof from "eslint-plugin-no-instanceof";

export default [
  ...rootConfig,
  {
    files: ["**/*.ts"],

    plugins: {
      "no-instanceof": noInstanceof,
    },

    rules: {
      "@typescript-eslint/no-empty-interface": 0,
      "@typescript-eslint/no-unused-vars": "off",

      "no-instanceof/no-instanceof": "error",
    },
  },
  {
    files: ["src/**/*.ts"],

    plugins: {
      jsdoc,
    },

    rules: {
      "jsdoc/require-jsdoc": [
        "error",
        {
          contexts: ["ClassDeclaration"],
        },
      ],
    },
  },
];
