/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import rootConfig from "../../../eslint.config.mjs";

export default [
  ...rootConfig,
  {
    files: ["**/*.test.ts"],

    rules: {
      // Treat itOnLinux as a test block.
      "jest/no-standalone-expect": [
        "error",
        { additionalTestBlockFunctions: ["itOnLinux.each"] },
      ],
    },
  },
];
