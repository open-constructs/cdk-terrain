// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import stripAnsi from "strip-ansi";
import { presentOutputs } from "../outputs";

const outputs = {
  db: { host: { sensitive: false, type: "string", value: "db.example.com" } },
};
const table = "db\n  host = db.example.com";

// A leaf that is neither an output nor a group makes the real renderer throw.
const unrenderable = { db: { host: undefined } } as any;

let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;
const printed = () => logSpy.mock.calls.map(([line]) => stripAnsi(line));
const reported = () => errSpy.mock.calls.map(([line]) => line);

beforeEach(() => {
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

function present(
  opts: Partial<Parameters<typeof presentOutputs>[0]> & { outputs: any },
) {
  presentOutputs({
    onOutputsRetrieved: () => {},
    renderFailureLabel: "Deploy succeeded",
    ...opts,
  });
}

describe("presentOutputs", () => {
  it("prints the outputs and nothing else when no outputs file was requested", () => {
    present({ outputs });

    expect(printed()).toEqual([table]);
    expect(reported()).toEqual([]);
  });

  it.each([
    ["undefined", undefined],
    ["empty", {}],
  ])("prints 'No outputs found.' for %s outputs", (_name, none) => {
    present({ outputs: none });

    expect(printed()).toEqual(["No outputs found."]);
  });

  it("hands the outputs to onOutputsRetrieved", () => {
    let retrieved: unknown;
    present({ outputs, onOutputsRetrieved: (o) => (retrieved = o) });

    expect(retrieved).toBe(outputs);
  });

  it("reports a render failure on stderr instead of throwing", () => {
    present({ outputs: unrenderable, renderFailureLabel: "Outputs fetched" });

    expect(printed()).toEqual([]);
    expect(reported()).toEqual([
      expect.stringMatching(
        /^\nOutputs fetched, but rendering the outputs failed: .+/,
      ),
    ]);
  });

  it.each([
    ["the outputs rendered", outputs, [table]],
    ["rendering failed", unrenderable, []],
    ["there are no outputs", {}, ["No outputs found."]],
  ])("says where the outputs were written when %s", (_name, given, before) => {
    present({ outputs: given, outputsPath: "/tmp/out.json" });

    expect(printed()).toEqual([
      ...before,
      "The outputs have been written to /tmp/out.json",
    ]);
  });
});
