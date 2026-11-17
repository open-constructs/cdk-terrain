/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import rootConfig from "../../../eslint.config.mjs";

export default [
  {
    ignores: [
      // prettier v2 managed inline snapshots
      "src/test/lib/cdktf-project.test.ts",
      "src/test/lib/terraform-logs.test.ts",
      "src/test/lib/execution-logs.test.ts",
    ],
  },
  ...rootConfig,
  {
    files: ["**/*.test.ts"],

    rules: {
      // Treat xstate's waitFor as an assertion.
      "jest/expect-expect": [
        "warn",
        { assertFunctionNames: ["expect", "waitFor"] },
      ],
    },
  },
];
