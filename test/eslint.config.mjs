/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import rootConfig from "../eslint.config.mjs";

export default [
  {
    ignores: [
      "**/.gen/**",
      "**/cdktf.out/**",
      "storage/**",
      "**/dist/**",
      "provider-tests/template/**",
      "provider-tests/providers/**",
    ],
  },
  ...rootConfig,
];
