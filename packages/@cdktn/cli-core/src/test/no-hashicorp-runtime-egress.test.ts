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

// With all network access disabled by nock, drive sendTelemetry, the Errors
// factories and reporting init + flush, and assert nothing connects to a
// HashiCorp host. The static source/bundle scan lives in cdktn-cli.

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
    // canary interceptor: any POST to the checkpoint API is routed here
    // and flips isDone() to true
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

    // full pipeline with real @sentry/node: init (capturing transport, no
    // network), emit usage metrics, construct errors, flush
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
    Errors.Internal("boom", new Error("boom"), { command: "synth" });
    Errors.Usage("bad flag", new Error("bad flag"), {});
    await Sentry.flush(2000);

    expect(hashicorp.isDone()).toBe(false);
  });
});
