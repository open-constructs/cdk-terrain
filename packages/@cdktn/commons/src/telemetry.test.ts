// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as Sentry from "@sentry/node";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  sendTelemetry,
  startCommandTelemetry,
  resetCommandTelemetry,
  getUsageTelemetryConsent,
  setUsageTelemetryEnabled,
} from "./telemetry";
import { Errors } from "./errors";

// A real client with a capturing transport proves the metric envelope
// reaches the transport and survives a bounded flush; a mocked @sentry/node
// would pass even if metrics were dropped before exit.

type MetricItem = {
  name: string;
  type: string;
  value: number;
  attributes: Record<string, { value: unknown; type: string }>;
};

function parseMetricItems(envelopeBodies: string[]): MetricItem[] {
  const items: MetricItem[] = [];
  for (const body of envelopeBodies) {
    const lines = body.split("\n").filter(Boolean);
    for (let i = 0; i < lines.length - 1; i++) {
      let header;
      try {
        header = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (header.type === "trace_metric") {
        const payload = JSON.parse(lines[i + 1]);
        items.push(...payload.items);
      }
    }
  }
  return items;
}

function attributeValues(item: MetricItem) {
  return Object.fromEntries(
    Object.entries(item.attributes).map(([k, v]) => [k, v.value]),
  );
}

describe("telemetry", () => {
  let workdir: string;
  let envelopeBodies: string[];
  const originalCwd = process.cwd();
  const originalCheckpointDisable = process.env.CHECKPOINT_DISABLE;
  const originalSentryEnvironment = process.env.SENTRY_ENVIRONMENT;

  function initSentryWithCapturingTransport() {
    Sentry.init({
      dsn: "https://public@example.invalid/1",
      release: "cdktn-cli-test",
      environment: "production",
      tracesSampleRate: 0,
      serverName: "cdktn-cli",
      // each test inits its own client; process-level integrations would
      // pile up listeners across tests and are irrelevant to metrics
      defaultIntegrations: false,
      transport: (options) =>
        Sentry.createTransport(options, async (request) => {
          envelopeBodies.push(request.body as string);
          return { statusCode: 200 };
        }),
    });
  }

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-telemetry-"));
    process.chdir(workdir);
    envelopeBodies = [];
    delete process.env.CHECKPOINT_DISABLE;
    delete process.env.SENTRY_ENVIRONMENT;
  });

  afterEach(async () => {
    setUsageTelemetryEnabled(undefined);
    resetCommandTelemetry();
    await Sentry.close(1000);
    process.chdir(originalCwd);
    fs.removeSync(workdir);
    if (originalCheckpointDisable === undefined) {
      delete process.env.CHECKPOINT_DISABLE;
    } else {
      process.env.CHECKPOINT_DISABLE = originalCheckpointDisable;
    }
    if (originalSentryEnvironment === undefined) {
      delete process.env.SENTRY_ENVIRONMENT;
    } else {
      process.env.SENTRY_ENVIRONMENT = originalSentryEnvironment;
    }
  });

  describe("sendTelemetry delivery (real client + capturing transport)", () => {
    it("stamps the command and language on every command metric", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
        sendUsageTelemetry: true,
      });
      initSentryWithCapturingTransport();

      await startCommandTelemetry("synth");
      await sendTelemetry("synth", { totalTime: 1234, language: "typescript" });
      await sendTelemetry("synth", { error: true });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      expect(items.map((i) => i.name)).toEqual([
        "cli.command.invoked",
        "cli.command.completed",
        "cli.synth.duration",
        "cli.command.error",
      ]);
      const [invoked, completed, duration, error] = items;

      for (const metric of items) {
        expect(attributeValues(metric).command).toBe("synth");
      }
      // the language comes from cdktf.json at start and from the payload
      // at the end; the error metric has no payload and reuses the start read
      expect(attributeValues(invoked).language).toBe("typescript");
      expect(attributeValues(completed).language).toBe("typescript");
      expect(duration.type).toBe("distribution");
      expect(duration.value).toBe(1234);
      expect(attributeValues(error)).toMatchObject({
        error_type: "unexpected",
        language: "typescript",
      });
    });

    it.each([
      ["Usage", "Usage"],
      ["External", "External"],
      ["Internal", "Internal"],
      ["Something Else", "unexpected"],
    ])(
      "stamps error_type %p as %p on cli.command.error",
      async (errorType, expected) => {
        fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
          sendUsageTelemetry: true,
        });
        initSentryWithCapturingTransport();

        await sendTelemetry("deploy", { error: true, errorType });
        expect(await Sentry.flush(2000)).toBe(true);

        const error = parseMetricItems(envelopeBodies).find(
          (i) => i.name === "cli.command.error",
        )!;
        expect(error.attributes.error_type.value).toBe(expected);
        expect(error.attributes.command.value).toBe("deploy");
      },
    );
  });

  describe("attribute validation", () => {
    beforeEach(() => {
      initSentryWithCapturingTransport();
    });

    it("omits an unsupported language, read from cdktf.json at start or passed at the end", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "rust; DROP TABLE",
      });

      await startCommandTelemetry("convert");
      await sendTelemetry("convert", { language: "cobol; DROP TABLE" });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      expect(items.map((i) => i.name)).toEqual([
        "cli.command.invoked",
        "cli.command.completed",
      ]);
      for (const item of items) {
        expect(item.attributes).not.toHaveProperty("language");
      }
      expect(envelopeBodies.join("\n")).not.toContain("DROP TABLE");
    });
  });

  describe("run lifecycle", () => {
    beforeEach(() => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "python",
        sendUsageTelemetry: true,
      });
      initSentryWithCapturingTransport();
    });

    it("counts the run once as invoked at start, even when reporting is initialized again", async () => {
      await startCommandTelemetry("init");
      // init runs get, which initializes reporting a second time
      await startCommandTelemetry("get");
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      expect(items.map((i) => i.name)).toEqual(["cli.command.invoked"]);
      expect(attributeValues(items[0])).toMatchObject({
        command: "init",
        language: "python",
      });
    });

    it("counts only the run's own command as completed; a nested operation adds its own metrics", async () => {
      await startCommandTelemetry("deploy");
      await sendTelemetry("synth", { totalTime: 42, language: "python" });
      await sendTelemetry("deploy", { language: "python" });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      expect(items.map((i) => [i.name, attributeValues(i).command])).toEqual([
        ["cli.command.invoked", "deploy"],
        ["cli.synth.duration", "synth"],
        ["cli.command.completed", "deploy"],
      ]);
    });

    it("counts a failed run once as error, never as completed", async () => {
      await startCommandTelemetry("synth");
      await sendTelemetry("synth", { error: true, errorType: "External" });
      expect(await Sentry.flush(2000)).toBe(true);

      expect(parseMetricItems(envelopeBodies).map((i) => i.name)).toEqual([
        "cli.command.invoked",
        "cli.command.error",
      ]);
    });

    it("emits nothing at start when usage telemetry is off, and stays a no-op afterwards", async () => {
      setUsageTelemetryEnabled(false);

      await startCommandTelemetry("synth");
      setUsageTelemetryEnabled(true);
      await startCommandTelemetry("synth");
      await Sentry.flush(2000);

      expect(parseMetricItems(envelopeBodies)).toHaveLength(0);
    });
  });

  // the bundle has one copy of this module per entry point: bin/cmds/handlers.js
  // captures the decision and starts the run, bin/cdktn.js counts the failure
  describe("shared across module copies", () => {
    type Telemetry = typeof import("./telemetry");
    let second: Telemetry;

    beforeEach(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        second = require("./telemetry");
      });
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "go",
        sendUsageTelemetry: true,
      });
      initSentryWithCapturingTransport();
    });

    it("observes the captured decision, the started command and its language from the other copy", async () => {
      // the project opts out; only the decision captured by the first copy
      // lets the second one emit
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "go",
        sendUsageTelemetry: false,
      });
      setUsageTelemetryEnabled(true);
      await startCommandTelemetry("deploy");
      await second.startCommandTelemetry("synth");
      await second.sendTelemetry("synth", { language: "go" });
      await second.sendTelemetry("deploy", { error: true, errorType: "Usage" });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      expect(items.map((i) => [i.name, attributeValues(i).command])).toEqual([
        ["cli.command.invoked", "deploy"],
        ["cli.command.error", "deploy"],
      ]);
      expect(attributeValues(items[1]).language).toBe("go");
    });
  });

  describe("sendTelemetry gating", () => {
    it.each([
      { env: undefined, captured: undefined, flag: undefined, emits: true },
      { env: undefined, captured: undefined, flag: true, emits: true },
      { env: undefined, captured: undefined, flag: false, emits: false },
      // convert chdirs into a throwaway project that opts out
      { env: undefined, captured: true, flag: false, emits: true },
      { env: undefined, captured: false, flag: true, emits: false },
      { env: "1", captured: undefined, flag: true, emits: false },
      { env: "1", captured: true, flag: true, emits: false },
    ])(
      "CHECKPOINT_DISABLE=$env, captured=$captured, flag=$flag -> emits $emits",
      async ({ env, captured, flag, emits }) => {
        if (flag !== undefined) {
          fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
            sendUsageTelemetry: flag,
          });
        }
        initSentryWithCapturingTransport();
        setUsageTelemetryEnabled(captured);
        if (env !== undefined) {
          process.env.CHECKPOINT_DISABLE = env;
        }

        await startCommandTelemetry("convert");
        await sendTelemetry("convert", {});
        await Sentry.flush(2000);

        const items = parseMetricItems(envelopeBodies);
        expect(items.some((i) => i.name === "cli.command.invoked")).toBe(emits);
        expect(items.some((i) => i.name === "cli.command.completed")).toBe(
          emits,
        );
        if (!emits) {
          expect(items).toHaveLength(0);
        }
      },
    );
  });

  describe("cli.error from the Errors factories", () => {
    afterEach(() => {
      Errors.setScope("unknown");
    });

    // the scope is read when the error is built, not when the factory is
    // created: a factory-time binding reports every error as "unknown"
    it("counts constructed errors by type with the command set at call time", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: true,
      });
      initSentryWithCapturingTransport();

      Errors.setScope("deploy");
      Errors.Usage("no stacks selected", undefined, { stackName: "secret" });
      Errors.External("terraform exited with code 1");
      expect(await Sentry.flush(2000)).toBe(true);

      const errors = parseMetricItems(envelopeBodies).filter(
        (i) => i.name === "cli.error",
      );
      expect(errors).toHaveLength(2);
      expect(errors.map((e) => e.attributes.type.value)).toEqual([
        "Usage",
        "External",
      ]);
      for (const error of errors) {
        expect(error.attributes.command.value).toBe("deploy");
        expect(error.attributes).not.toHaveProperty("message");
        expect(error.attributes).not.toHaveProperty("stackName");
      }
      expect(JSON.stringify(errors)).not.toContain("secret");
      expect(JSON.stringify(errors)).not.toContain("no stacks selected");
    });
  });

  describe("getUsageTelemetryConsent", () => {
    it.each([
      // init templates render the flag as a string; a boolean-only check
      // would opt every freshly init'ed project out
      [{ sendUsageTelemetry: "true" }, true],
      [{ sendUsageTelemetry: "false" }, false],
      [{}, undefined],
      // malformed is unset, not an opt-out
      [{ sendUsageTelemetry: "yes" }, undefined],
    ])("reads %j as %p", (config, expected) => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), config);
      expect(getUsageTelemetryConsent(workdir)).toBe(expected);
    });

    it("returns undefined when no cdktf.json exists", () => {
      expect(getUsageTelemetryConsent(workdir)).toBeUndefined();
    });
  });
});
