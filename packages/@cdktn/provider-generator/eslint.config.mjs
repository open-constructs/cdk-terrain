/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import rootConfig from "../../../eslint.config.mjs";

export default [
  {
    ignores: ["edge-provider-bindings/providers/**", "build/**", "dist/**"],
  },
  ...rootConfig,
  {
    files: ["**/*.test.ts"],

    rules: {
      // Treat onTf1_6AndNewer as a test block.
      "jest/no-standalone-expect": [
        "error",
        { additionalTestBlockFunctions: ["onTf1_6AndNewer"] },
      ],
    },
  },
];
