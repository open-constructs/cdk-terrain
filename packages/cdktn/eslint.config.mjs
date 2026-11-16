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
      // JSII has no type aliases, so empty and single-extends interfaces are the only way to express them
      "@typescript-eslint/no-empty-object-type": [
        "warn",
        { allowInterfaces: "always" },
      ],
      // `declare global { namespace jest }` is how the jest adapter augments jest's matcher types
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
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
  {
    files: ["**/*.test.ts"],

    rules: {
      // Treat the testIf* aliases as test blocks.
      "jest/no-standalone-expect": [
        "error",
        {
          additionalTestBlockFunctions: [
            "testIfSymlinks",
            "testIfUnzip",
            "testIfSymlinksAndUnzip",
            "testIfPosixPermissions",
            "testIfPosixPermissionsAndUnzip",
          ],
        },
      ],
    },
  },
];
