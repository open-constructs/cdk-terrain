// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const watcher = Object.assign(new EventEmitter(), {
  close: jest.fn().mockResolvedValue(undefined),
});
jest.mock("chokidar", () => ({ watch: () => watcher }));

// A deploy that runs until the project is hard-aborted, like a real one
// waiting on terraform.
let currentDeploy: { reject: (e: Error) => void } | undefined;
jest.mock("../../lib/cdktf-project", () => ({
  CdktfProject: class {
    public stacksToRun = [];
    public hardAbort = () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      currentDeploy?.reject(e);
    };
    public deploy = () =>
      new Promise<void>((_resolve, reject) => {
        currentDeploy = { reject };
      });
  },
}));

import { watch, State } from "../../lib/watch";

const settled = (p: Promise<unknown>) =>
  Promise.race([
    p.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 50)),
  ]);

describe("watch", () => {
  const originalCwd = process.cwd();
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-watch-"));
    fs.writeFileSync(
      path.join(tmp, "cdktf.json"),
      JSON.stringify({ language: "typescript", watchPattern: ["./**/*.ts"] }),
    );
    process.chdir(tmp);
    watcher.close.mockClear();
    currentDeploy = undefined;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // the CLI exits as soon as the handler returns, so an early resolution
  // would end `cdktn watch` right after its first deploy started
  it("stays pending until aborted, then stops the watcher and settles the in-flight run", async () => {
    const ac = new AbortController();
    const states: State["type"][] = [];
    const session = watch(
      { synthCommand: "true", outDir: "out", onUpdate: () => {} },
      { autoApprove: true },
      ac.signal,
      (state) => states.push(state.type),
    );

    expect(await settled(session)).toBe(false);
    expect(states).toEqual(["running"]);
    expect(watcher.close).not.toHaveBeenCalled();

    ac.abort();

    await session;
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(states[states.length - 1]).toBe("stopped");
  });
});
