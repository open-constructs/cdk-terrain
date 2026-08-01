/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import rootConfig from "../eslint.config.mjs";

export default [
  {
    ignores: [
      "**/.gen/**",
      "edge-provider-bindings/**",
      "**/cdktf.out/**",
      "storage/**",
      "**/dist/**",
      "provider-tests/template/**",
      "provider-tests/providers/**",
    ],
  },
  ...rootConfig,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // test/ is a standalone pnpm project (it is not in pnpm-workspace.yaml
      // and is installed separately by the integration scripts), so its
      // node_modules lives inside this project's own root. nx maps files to
      // projects by root containment, so every bare import resolves back to
      // this same project and the rule treats it as a self-import -- it
      // reports "use a relative import instead of has-ansi" for npm packages.
      //
      // Before it gets that far it usually just crashes: the same code path
      // calls path.join(workspaceRoot, getRootTsConfigFileName()), and this
      // workspace has no root tsconfig, so that joins null and takes down the
      // whole lint run. CI never installs test/node_modules, so this only
      // ever surfaces locally.
      "@nx/enforce-module-boundaries": "off",
    },
  },
];
