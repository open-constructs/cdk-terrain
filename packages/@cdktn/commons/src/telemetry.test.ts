// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as Sentry from "@sentry/node";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  sendTelemetry,
  getUsageTelemetryConsent,
  isUsageTelemetryEnabled,
  setUsageTelemetryEnabled,
} from "./telemetry";

// Delivery oracle (contract C5): a real v10 client with a capturing
// transport proves the metric envelope actually reaches the transport and
// survives a bounded flush — a pure @sentry/node mock would pass even if
// metrics were silently dropped before exit.

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

describe("telemetry", () => {
  let workdir: string;
  let envelopeBodies: string[];
  const originalCwd = process.cwd();
  const originalCheckpointDisable = process.env.CHECKPOINT_DISABLE;

  function initSentryWithCapturingTransport() {
    Sentry.init({
      dsn: "https://public@example.invalid/1",
      release: "cdktn-cli-test",
      tracesSampleRate: 0,
      serverName: "cdktn-cli",
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
  });

  afterEach(async () => {
    setUsageTelemetryEnabled(undefined);
    await Sentry.close(1000);
    process.chdir(originalCwd);
    fs.removeSync(workdir);
    if (originalCheckpointDisable === undefined) {
      delete process.env.CHECKPOINT_DISABLE;
    } else {
      process.env.CHECKPOINT_DISABLE = originalCheckpointDisable;
    }
  });

  describe("sendTelemetry delivery (real client + capturing transport)", () => {
    it("delivers cli.command.invoked and cli.synth.duration through a bounded flush", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
        sendUsageTelemetry: true,
      });
      initSentryWithCapturingTransport();

      await sendTelemetry("synth", {
        totalTime: 1234,
        language: "typescript",
      });

      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      const invoked = items.find((i) => i.name === "cli.command.invoked");
      const duration = items.find((i) => i.name === "cli.synth.duration");

      expect(invoked).toBeDefined();
      expect(invoked!.attributes.command.value).toBe("synth");
      expect(invoked!.attributes.language.value).toBe("typescript");
      expect(invoked!.attributes.ci).toBeDefined();

      expect(duration).toBeDefined();
      expect(duration!.type).toBe("distribution");
      expect(duration!.value).toBe(1234);
    });

    it("emits cli.command.error (not invoked) for error payloads", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
        sendUsageTelemetry: true,
      });
      initSentryWithCapturingTransport();

      await sendTelemetry("synth", { error: true, synthOrigin: "watch" });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      expect(items.some((i) => i.name === "cli.command.error")).toBe(true);
      expect(items.some((i) => i.name === "cli.command.invoked")).toBe(false);
    });

    it("never attaches the machine hostname to metrics (serverName constant)", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: true,
      });
      initSentryWithCapturingTransport();

      await sendTelemetry("synth", {});
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        const serverAddress = item.attributes["server.address"];
        if (serverAddress) {
          expect(serverAddress.value).toBe("cdktn-cli");
          expect(serverAddress.value).not.toBe(os.hostname());
        }
      }
    });
  });

  describe("sendTelemetry gating", () => {
    it("emits nothing when CHECKPOINT_DISABLE is set, regardless of consent", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: true,
      });
      initSentryWithCapturingTransport();
      process.env.CHECKPOINT_DISABLE = "1";

      await sendTelemetry("synth", {});
      await Sentry.flush(2000);

      expect(parseMetricItems(envelopeBodies)).toHaveLength(0);
    });

    it("emits nothing when sendUsageTelemetry is false", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: false,
      });
      initSentryWithCapturingTransport();

      await sendTelemetry("synth", {});
      await Sentry.flush(2000);

      expect(parseMetricItems(envelopeBodies)).toHaveLength(0);
    });

    it("emits when the flag is unset (legacy default-on)", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
      });
      initSentryWithCapturingTransport();

      await sendTelemetry("get", { language: "typescript" });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      expect(items.some((i) => i.name === "cli.command.invoked")).toBe(true);
    });

    it("emits when no cdktf.json exists (no-project commands, legacy default-on)", async () => {
      initSentryWithCapturingTransport();

      await sendTelemetry("convert", {});
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      expect(items.some((i) => i.name === "cli.command.invoked")).toBe(true);
    });

    it("is a silent no-op when Sentry is not initialized", async () => {
      await expect(sendTelemetry("synth", {})).resolves.toBeUndefined();
      expect(envelopeBodies).toHaveLength(0);
    });

    it("honors the decision captured at command start over the current cwd (convert chdirs into a temp project)", async () => {
      // the throwaway project convert chdirs into opts out…
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: false,
      });
      initSentryWithCapturingTransport();
      // …but the decision captured in the user's original cwd was "enabled"
      setUsageTelemetryEnabled(true);

      await sendTelemetry("convert", {});
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      expect(items.some((i) => i.name === "cli.command.invoked")).toBe(true);
    });

    it("CHECKPOINT_DISABLE overrides even a captured enabled decision", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: true,
      });
      initSentryWithCapturingTransport();
      setUsageTelemetryEnabled(true);
      process.env.CHECKPOINT_DISABLE = "1";

      await sendTelemetry("convert", {});
      await Sentry.flush(2000);

      expect(parseMetricItems(envelopeBodies)).toHaveLength(0);
    });
  });

  describe("getUsageTelemetryConsent", () => {
    it.each([
      [{ sendUsageTelemetry: true }, true],
      [{ sendUsageTelemetry: false }, false],
      [{ sendUsageTelemetry: "true" }, true],
      [{ sendUsageTelemetry: "false" }, false],
      [{}, undefined],
    ])("reads %j as %p", (config, expected) => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), config);
      expect(getUsageTelemetryConsent(workdir)).toBe(expected);
    });

    it("returns undefined when no cdktf.json exists", () => {
      expect(getUsageTelemetryConsent(workdir)).toBeUndefined();
    });
  });

  describe("isUsageTelemetryEnabled precedence", () => {
    it("CHECKPOINT_DISABLE wins over an explicit true", () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: true,
      });
      process.env.CHECKPOINT_DISABLE = "1";
      expect(isUsageTelemetryEnabled(workdir)).toBe(false);
    });

    it("explicit false wins over the default", () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: false,
      });
      expect(isUsageTelemetryEnabled(workdir)).toBe(false);
    });

    it("unset defaults to enabled", () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {});
      expect(isUsageTelemetryEnabled(workdir)).toBe(true);
    });
  });
});
