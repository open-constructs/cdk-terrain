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
];
