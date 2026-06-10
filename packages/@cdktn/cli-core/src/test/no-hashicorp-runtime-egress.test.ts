// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import nock from "nock";
import * as os from "os";
import * as path from "path";

// keep @sentry/node and the telemetry pipeline REAL — only stub the debug
// collector, which shells out to external tools and is fire-and-forget
jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  collectDebugInformation: jest.fn().mockResolvedValue({}),
}));

import * as Sentry from "@sentry/node";
import { Errors, sendTelemetry } from "@cdktn/commons";
import { initializErrorReporting } from "../lib/error-reporting";

// Runtime no-egress oracle (quickstart Journey 1, FR-001/SC-001): with all
// network access disabled by nock, exercise every path that used to POST
// to checkpoint-api.hashicorp.com (sendTelemetry, the Errors factories,
// reporting init + flush) and assert no connection to a HashiCorp host is
// ever attempted. Complements the static source/bundle scan in
// cdktn-cli/src/test/no-hashicorp-egress.test.ts.

describe("runtime no-egress to HashiCorp", () => {
  let workdir: string;
  const originalCwd = process.cwd();
  const originalEnv = {
    SENTRY_DSN: process.env.SENTRY_DSN,
    CHECKPOINT_DISABLE: process.env.CHECKPOINT_DISABLE,
  };

  beforeAll(() => {
    nock.disableNetConnect();
  });

  afterAll(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-egress-"));
    process.chdir(workdir);
    delete process.env.CHECKPOINT_DISABLE;
    process.env.SENTRY_DSN = "https://public@example.invalid/1";
  });

  afterEach(async () => {
    await Sentry.close(1000);
    process.chdir(originalCwd);
    fs.removeSync(workdir);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("telemetry and error paths never attempt a HashiCorp connection", async () => {
    // a canary interceptor: if any code still POSTed to the checkpoint
    // API, nock would route it here and isDone() would flip to true
    const hashicorp = nock("https://checkpoint-api.hashicorp.com")
      .persist()
      .post(/.*/)
      .reply(201, "");

    fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
      language: "typescript",
      sendCrashReports: true,
      sendUsageTelemetry: true,
      projectId: "egress-test",
    });

    // full pipeline, real @sentry/node: init (capturing transport — no
    // network), emit usage metrics, construct legacy-reporting errors,
    // flush before exit
    await initializErrorReporting();
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0,
      serverName: "cdktn-cli",
      transport: (options) =>
        Sentry.createTransport(options, async () => ({ statusCode: 200 })),
    });

    await sendTelemetry("synth", { totalTime: 12, language: "typescript" });
    await sendTelemetry("synth", { error: true });
    // the Errors factories fired a checkpoint ReportRequest before 002
    Errors.Internal("boom", new Error("boom"), { command: "synth" });
    Errors.Usage("bad flag", new Error("bad flag"), {});
    await Sentry.flush(2000);

    expect(hashicorp.isDone()).toBe(false);
  });
});
