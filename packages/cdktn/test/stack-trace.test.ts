// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Lazy } from "../src";
import {
  captureCreationStack,
  captureStackTrace,
} from "../src/tokens/private/stack-trace";

const ENV_VAR = "CDKTN_DISABLE_CREATION_STACK";

describe("captureCreationStack", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = previous;
    }
  });

  test("returns a non-empty stack when env var is unset", () => {
    const stack = captureCreationStack();
    expect(stack.length).toBeGreaterThan(0);
  });

  test("returns [] when env var is 'true'", () => {
    process.env[ENV_VAR] = "true";
    expect(captureCreationStack()).toEqual([]);
  });

  test("returns [] when env var is '1'", () => {
    process.env[ENV_VAR] = "1";
    expect(captureCreationStack()).toEqual([]);
  });

  test("returns a non-empty stack for other values like 'false' or '0'", () => {
    process.env[ENV_VAR] = "false";
    expect(captureCreationStack().length).toBeGreaterThan(0);

    process.env[ENV_VAR] = "0";
    expect(captureCreationStack().length).toBeGreaterThan(0);
  });

  test("does not affect captureStackTrace, which is general-purpose", () => {
    process.env[ENV_VAR] = "true";
    expect(captureStackTrace().length).toBeGreaterThan(0);
  });

  test("Lazy.anyValue.creationStack is [] when env var is set", () => {
    process.env[ENV_VAR] = "true";
    const lazy = Lazy.anyValue({ produce: () => 1 });
    expect(lazy.creationStack).toEqual([]);
  });

  test("Lazy.anyValue.creationStack is populated when env var is unset", () => {
    const lazy = Lazy.anyValue({ produce: () => 1 });
    expect(lazy.creationStack.length).toBeGreaterThan(0);
  });
});
