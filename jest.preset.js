/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

const { nxPreset } = require('@nx/jest/preset');

/** Suppresses HashiCorp Checkpoint update-check HTTP calls during tests. */
process.env.CHECKPOINT_DISABLE = '1';

/** Suppress node DeprecationWarnings etc. so tests can assert on empty stderr. */
process.env.NODE_NO_WARNINGS = '1';

module.exports = {
  ...nxPreset,
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  coverageReporters: ['text', 'text-summary', 'json-summary'],
};
