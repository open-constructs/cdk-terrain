/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */
/* eslint-disable */
const { readFileSync } = require('fs');

const swcJestConfig = JSON.parse(
  readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'),
);

swcJestConfig.swcrc = false;

module.exports = {
  displayName: '@cdktn/hcl2cdk',
  preset: '../../../jest.preset.js',
  rootDir: '.',
  roots: ['<rootDir>'],
  transform: {
    '^.+\\.[tj]sx?$': ['@swc/jest', swcJestConfig],
  },
  globalSetup: './test/globalSetup.ts',
  globalTeardown: './test/globalTeardown.ts',
  coverageDirectory: 'test-output/jest/coverage',
};
