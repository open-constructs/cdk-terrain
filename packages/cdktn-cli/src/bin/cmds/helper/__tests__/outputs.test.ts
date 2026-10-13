// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import stripAnsi from "strip-ansi";
import { saveOutputs } from "@cdktn/cli-core";
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
  return presentOutputs({
    onOutputsRetrieved: () => {},
    renderFailureLabel: "Deploy succeeded",
    ...opts,
  });
}

describe("presentOutputs", () => {
  it("prints the outputs and nothing else when no outputs file was requested", async () => {
    await present({ outputs });

    expect(printed()).toEqual([table]);
    expect(reported()).toEqual([]);
  });

  it.each([
    ["undefined", undefined],
    ["empty", {}],
  ])("prints 'No outputs found.' for %s outputs", async (_name, none) => {
    await present({ outputs: none });

    expect(printed()).toEqual(["No outputs found."]);
  });

  it("hands the outputs to onOutputsRetrieved", async () => {
    let retrieved: unknown;
    await present({
      outputs,
      onOutputsRetrieved: (o) => {
        retrieved = o;
      },
    });

    expect(retrieved).toBe(outputs);
  });

  it("reports a render failure on stderr instead of throwing", async () => {
    await present({
      outputs: unrenderable,
      renderFailureLabel: "Outputs fetched",
    });

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
  ])(
    "says where the outputs were written when %s",
    async (_name, given, before) => {
      await present({ outputs: given, outputsPath: "/tmp/out.json" });

      expect(printed()).toEqual([
        ...before,
        "The outputs have been written to /tmp/out.json",
      ]);
    },
  );
});

describe("presentOutputs writing the outputs file", () => {
  const writtenTo = "The outputs have been written to /tmp/out.json";
  const failure = (code: string) =>
    Object.assign(new Error(`${code}: cannot write '/tmp/out.json'`), { code });

  // Handled up front, so a caller that drops the promise fails an assertion instead of crashing the test run.
  const handled = (write: Promise<void>) => {
    write.catch(() => {});
    return write;
  };

  it("waits for the write before saying where the outputs were written", async () => {
    let printedWhenWritten: string[] = [];

    await present({
      outputs,
      outputsPath: "/tmp/out.json",
      onOutputsRetrieved: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        printedWhenWritten = printed();
      },
    });

    expect(printedWhenWritten).toEqual([table]);
    expect(printed()).toEqual([table, writtenTo]);
  });

  it.each([
    ["ENOENT", "Usage"],
    ["ENOTDIR", "Usage"],
    ["EACCES", "External"],
  ])("rejects a write failing with %s as a %s error", async (code, type) => {
    const cause = failure(code);

    const rejection = await present({
      outputs,
      outputsPath: "/tmp/out.json",
      onOutputsRetrieved: () => handled(Promise.reject(cause)),
    }).catch((e) => e);

    expect(rejection).toMatchObject({
      __type: type,
      message: `${type} Error: Failed to write outputs: ${cause.message}`,
      stack: cause.stack,
    });
  });

  it("keeps the outputs printed, without the written-to line, when the write fails", async () => {
    await expect(
      present({
        outputs,
        outputsPath: "/tmp/out.json",
        onOutputsRetrieved: () => handled(Promise.reject(failure("EACCES"))),
      }),
    ).rejects.toThrow("Failed to write outputs");

    expect(printed()).toEqual([table]);
  });

  it("rejects with a Usage error when saveOutputs targets a directory that does not exist", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-outputs-"));
    const outputsPath = path.join(dir, "missing", "out.json");

    try {
      const rejection = await present({
        outputs,
        outputsPath,
        onOutputsRetrieved: (o) => handled(saveOutputs(outputsPath, o, false)),
      }).catch((e) => e);

      expect(rejection).toMatchObject({ __type: "Usage" });
      expect(rejection.message).toMatch(
        /^Usage Error: Failed to write outputs: .*ENOENT/,
      );
      expect(rejection.message).toContain(outputsPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
