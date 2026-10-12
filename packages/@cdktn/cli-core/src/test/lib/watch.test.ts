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

// Each deploy stays pending until the test settles it or until some time
// after the project is hard-aborted, like a real one waiting on terraform.
type Deploy = { resolve: () => void; reject: (e: Error) => void };
const deploys: Deploy[] = [];
let pendingDeploys = 0;
let hardAborts = 0;
jest.mock("../../lib/cdktf-project", () => ({
  CdktfProject: class {
    public stacksToRun = [];
    private current?: Deploy;
    public hardAbort = () => {
      hardAborts++;
      const e = new Error("aborted");
      e.name = "AbortError";
      setTimeout(() => this.current?.reject(e), 5);
    };
    public deploy = () => {
      pendingDeploys++;
      return new Promise<void>((resolve, reject) => {
        this.current = { resolve, reject };
        deploys.push(this.current);
      }).finally(() => pendingDeploys--);
    };
  },
}));

import { watch, State } from "../../lib/watch";

const settled = (p: Promise<unknown>) =>
  Promise.race([
    p.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 50)),
  ]);

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("watch", () => {
  const originalCwd = process.cwd();
  let tmp: string;

  function startWatch() {
    const ac = new AbortController();
    const states: State["type"][] = [];
    const session = watch(
      { synthCommand: "true", outDir: "out", onUpdate: () => {} },
      { autoApprove: true },
      ac.signal,
      (state) => states.push(state.type),
    );
    return { ac, states, session, lastState: () => states[states.length - 1] };
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-watch-"));
    fs.writeFileSync(
      path.join(tmp, "cdktf.json"),
      JSON.stringify({ language: "typescript", watchPattern: ["./**/*.ts"] }),
    );
    process.chdir(tmp);
    watcher.close.mockClear();
    watcher.removeAllListeners();
    deploys.length = 0;
    pendingDeploys = 0;
    hardAborts = 0;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // the CLI exits as soon as the handler returns, so an early resolution
  // would end `cdktn watch` right after its first deploy started
  it("stays pending until aborted, then stops the watcher and settles the in-flight run", async () => {
    const { ac, states, session, lastState } = startWatch();

    expect(await settled(session)).toBe(false);
    expect(states).toContain("running");
    expect(watcher.close).not.toHaveBeenCalled();

    ac.abort();

    await session;
    expect(pendingDeploys).toBe(0);
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(lastState()).toBe("stopped");
  });

  it("rejects with the error of a deploy that fails, and stops", async () => {
    const { ac, session, lastState } = startWatch();
    const failure = new Error("terraform apply failed");

    deploys[0].reject(failure);

    await expect(session).rejects.toBe(failure);
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(lastState()).toBe("stopped");

    // a finished deploy must not be aborted by a later signal
    ac.abort();
    expect(hardAborts).toBe(0);
    // jest fails a test during which a rejection goes unhandled
    await tick();
  });

  it("runs once more for the changes made during a deploy, then waits", async () => {
    const { ac, session, lastState } = startWatch();

    watcher.emit("all");
    watcher.emit("all");
    deploys[0].resolve();
    await tick();
    expect(deploys).toHaveLength(2);
    expect(lastState()).toBe("running");

    deploys[1].resolve();
    await tick();
    expect(deploys).toHaveLength(2);
    expect(lastState()).toBe("waiting");

    ac.abort();
    await session;
  });

  it("rejects with the error of a queued re-run that fails", async () => {
    const { session } = startWatch();
    const failure = new Error("terraform apply failed");

    watcher.emit("all");
    deploys[0].resolve();
    await tick();
    deploys[1].reject(failure);

    await expect(session).rejects.toBe(failure);
    await tick();
  });

  it.each(["a failure", "an abort"])(
    "starts nothing for a change that arrives after %s",
    async (ending) => {
      const { ac, session } = startWatch();
      deploys[0].resolve();
      await tick();

      if (ending === "an abort") {
        ac.abort();
        await session;
      } else {
        watcher.emit("all");
        deploys[1].reject(new Error("terraform apply failed"));
        await expect(session).rejects.toThrow("terraform apply failed");
      }
      const started = deploys.length;

      watcher.emit("all");
      await tick();

      expect(deploys).toHaveLength(started);
    },
  );
});
