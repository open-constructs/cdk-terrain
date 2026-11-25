// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Testing } from "../../src/testing";

// Removes the temp outdirs Testing.app() and Testing.fullSynth() created in each
// test file; their exit-time cleanup never runs under Jest. Wired in via jest.config.js.
afterAll(() => Testing.cleanup());
