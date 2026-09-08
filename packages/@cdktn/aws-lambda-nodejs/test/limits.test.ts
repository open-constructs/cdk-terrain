// Copyright (c) OpenConstructs
// SPDX-License-Identifier: MPL-2.0
import { App, TerraformStack, Testing } from "cdktn";
import { NodejsAsset } from "@cdktn/bundler-nodejs";
import { NodejsFunction } from "../src";

// Exercise the Lambda quota boundaries without allocating hundreds of MiB in
// every unit-test run. The bundler suite verifies sizes against real ZIPs.
jest.mock("@cdktn/bundler-nodejs", () => ({ NodejsAsset: jest.fn() }));

const mib = 1024 * 1024;

function create(compressedSize: number, uncompressedSize: number) {
  jest.mocked(NodejsAsset).mockImplementation(
    () =>
      ({
        compressedSize,
        uncompressedSize,
        path: "assets/code.zip",
        handler: "index.handler",
        sourceCodeHash: "code-hash",
      }) as NodejsAsset,
  );
  const stack = new TerraformStack(new App(), "test");
  const fn = new NodejsFunction(stack, "handler", { entry: "handler.ts" });
  return { stack, fn };
}

test.each([
  [50 * mib - 1, 250 * mib - 1],
  [50 * mib, 250 * mib],
])(
  "accepts a ZIP within both documented limits (%i, %i bytes)",
  (compressed, uncompressed) => {
    const { stack, fn } = create(compressed, uncompressed);
    expect(fn.code.compressedSize).toBe(compressed);
    expect(Testing.synth(stack)).toContain("assets/code.zip");
  },
);

test("rejects a ZIP one byte above the direct upload limit", () => {
  expect(() => create(50 * mib + 1, 100 * mib)).toThrow(
    /test\/handler: ZIP is 52428801 bytes.*50 MiB \(52428800 bytes\).*S3/,
  );
});

test("rejects a small ZIP whose entries exceed the uncompressed limit", () => {
  expect(() => create(mib, 250 * mib + 1)).toThrow(
    /uncompressed package is 262144001 bytes.*250 MiB \(262144000 bytes\).*including layers/,
  );
});

test("reports the uncompressed limit first when both limits are exceeded", () => {
  expect(() => create(51 * mib, 251 * mib)).toThrow(/uncompressed package/);
});
