/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

jest.mock("../terraform-check", () => ({ terraformCheck: jest.fn() }));

type OnUpdate = (update: { type: string; stackName?: string }) => void;
type OnLog = (msg: {
  stackName: string;
  message: string;
  messageWithConstructPath?: string;
}) => void;

let capturedOnUpdate: OnUpdate;
let capturedOnLog: OnLog;

jest.mock("@cdktn/cli-core", () => ({
  CdktfProject: class {
    public hardAbort = jest.fn();
    constructor(opts: { onUpdate: OnUpdate; onLog?: OnLog }) {
      capturedOnUpdate = opts.onUpdate;
      capturedOnLog = opts.onLog!;
    }
  },
}));

import { renderPlain } from "../render-plain";

describe("renderPlain", () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits one line per stack/log event and de-dupes status announcements", async () => {
    await renderPlain({ outDir: "out", synthCommand: "noop" }, async () => {
      capturedOnUpdate({ type: "synthesizing" });
      capturedOnUpdate({ type: "synthesizing" });
      capturedOnUpdate({ type: "synthesized", stacks: [] } as any);
      capturedOnLog({
        stackName: "stack-a",
        message: "Initializing the backend...",
      });
      capturedOnLog({
        stackName: "stack-a",
        message: "line one\nline two",
      });
    });

    expect(logSpy.mock.calls.map((c) => c[0])).toEqual([
      "Synthesizing",
      "Synthesized",
      "stack-a  Initializing the backend...",
      "stack-a  line one",
      "stack-a  line two",
    ]);
  });

  it("throws when an interactive prompt is required", async () => {
    await expect(
      renderPlain({ outDir: "out", synthCommand: "noop" }, async () => {
        capturedOnUpdate({
          type: "waiting for approval",
          stackName: "stack-a",
        });
      }),
    ).rejects.toThrow(/not a TTY/);
  });
});
