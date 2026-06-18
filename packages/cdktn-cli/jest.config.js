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
  displayName: 'cdktn-cli',
  preset: '../../jest.preset.js',
  rootDir: '.',
  roots: ['<rootDir>'],
  transform: {
    '^.+\\.[tj]sx?$': ['@swc/jest', swcJestConfig],
  },
  // sscaff (in node_modules) ships both .ts source and compiled .js — prefer
  // .js so jest doesn't try to parse the untransformed source.
  moduleFileExtensions: ['js', 'ts', 'tsx'],
  coverageDirectory: 'test-output/jest/coverage',
};
