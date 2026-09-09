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
  getBinaryAttributes,
  getProjectTargetAttributes,
  getUsageTelemetryConsent,
  setProjectTargetAttributes,
  setUsageTelemetryEnabled,
} from "./telemetry";
import { seedTerraformCliProbeForTests } from "./terraform";
import { DEFAULT_TARGET_VERSIONS } from "./config";
import { Errors } from "./errors";

const DEFAULT_TARGET_VERSIONS_AS_ATTRIBUTES = {
  target_terraform: DEFAULT_TARGET_VERSIONS.terraform,
  target_opentofu: DEFAULT_TARGET_VERSIONS.opentofu,
};

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
    // the probe is process-global (see terraform.ts); a seeded output keeps
    // the binary attributes independent of the machine running the tests
    seedTerraformCliProbeForTests(
      Promise.resolve("Terraform v1.9.0\non darwin_arm64\n"),
    );
  });

  afterEach(async () => {
    setUsageTelemetryEnabled(undefined);
    resetCommandTelemetry();
    setProjectTargetAttributes(undefined);
    seedTerraformCliProbeForTests();
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
    it("stamps the command, language, binary and target attributes on every command metric", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
        sendUsageTelemetry: true,
        targetVersions: { terraform: ">=1.9.0", opentofu: ">=1.8.0" },
        validateInstalledBinary: true,
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
        expect(attributeValues(metric)).toMatchObject({
          command: "synth",
          os: process.platform,
          arch: process.arch,
          binary: "terraform",
          binary_version: "1.9.0",
          target_terraform: ">=1.9.0",
          target_opentofu: ">=1.8.0",
          targets_declared: true,
          validate_installed_binary: true,
        });
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

    it("uses the target attributes captured at command start over the current cwd", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        targetVersions: { terraform: ">=1.0.0" },
      });
      initSentryWithCapturingTransport();
      setProjectTargetAttributes({
        targets_declared: true,
        validate_installed_binary: false,
        target_opentofu: ">=1.7.0",
      });

      await startCommandTelemetry("convert");
      await sendTelemetry("convert", {});
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      expect(items.map((i) => i.name)).toEqual([
        "cli.command.invoked",
        "cli.command.completed",
      ]);
      for (const metric of items) {
        expect(metric.attributes.target_opentofu.value).toBe(">=1.7.0");
        expect(metric.attributes.target_terraform).toBeUndefined();
      }
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

    it("forwards exactly the allow-listed attribute set and nothing else from the payload", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
        sendUsageTelemetry: true,
      });
      initSentryWithCapturingTransport();

      await startCommandTelemetry("synth");
      await sendTelemetry("synth", {
        totalTime: 5,
        language: "typescript",
        stackMetadata: [{ stackName: "prod-vpc", backend: "s3" }],
        requiredProviders: [{ aws: { source: "aws" } }],
        stackName: "prod-vpc",
        outdir: "/Users/x/secret",
      });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      const invoked = items.find((i) => i.name === "cli.command.invoked")!;
      const completed = items.find((i) => i.name === "cli.command.completed")!;
      const keys = Object.keys(invoked.attributes);
      // the start and end metrics carry the same base set
      expect(Object.keys(completed.attributes).sort()).toEqual(
        [...keys].sort(),
      );
      // the one place that fails when an attribute is added: extend it
      // deliberately, together with the collected-data list in the docs
      expect(keys.filter((key) => !key.startsWith("sentry.")).sort()).toEqual([
        "arch",
        "binary",
        "binary_version",
        "ci",
        "command",
        "language",
        "os",
        // server.address is the fixed serverName from init
        "server.address",
        "target_opentofu",
        "target_terraform",
        "targets_declared",
        "validate_installed_binary",
      ]);
      // stamped by the SDK from init; a patch bump may add more of them
      expect(keys).toEqual(
        expect.arrayContaining(["sentry.release", "sentry.environment"]),
      );
      expect(invoked.attributes.binary_version.value).toBe("1.9.0");
      expect(invoked.attributes["server.address"].value).toBe("cdktn-cli");
      const bytes = envelopeBodies.join("\n");
      expect(bytes).not.toContain("prod-vpc");
      expect(bytes).not.toContain("/Users/x/secret");
    });
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

    it("sends declared targets that are not semver ranges as invalid", () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        targetVersions: { terraform: "latest /Users/x", opentofu: ">=1.8" },
      });
      expect(getProjectTargetAttributes(workdir)).toMatchObject({
        target_terraform: "invalid",
        target_opentofu: ">=1.8.0",
      });
    });

    it.each([
      [">= 1.9.0", ">=1.9.0"],
      ["~1.8", ">=1.8.0 <1.9.0-0"],
      ["1.2.3 - 2.0.0", ">=1.2.3 <=2.0.0"],
      [">=1.0.0 <2.0.0 || 1.2.3", ">=1.0.0 <2.0.0||1.2.3"],
      [">= 1.0.0-LEAK-TV-PRERELEASE.corp.example.com", "invalid"],
      ["1.2.3-acme.internal", "invalid"],
      ["1.2.3+LEAK-TV-BUILD.johns-macbook", "invalid"],
      [">=1.0.0 <2.0.0 || 1.2.3-LEAK-OR.host", "invalid"],
      [">=1.0.0 " + "||1.0.0 ".repeat(10), "invalid"],
    ])("forwards the declared target %p as %p", (range, expected) => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        targetVersions: { terraform: range },
      });
      expect(getProjectTargetAttributes(workdir).target_terraform).toBe(
        expected,
      );
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

    it("stamps the target attributes captured by the other copy", async () => {
      setProjectTargetAttributes({
        targets_declared: true,
        validate_installed_binary: true,
        target_opentofu: ">=1.7.0",
      });
      await second.sendTelemetry("convert", {});
      expect(await Sentry.flush(2000)).toBe(true);

      const [completed] = parseMetricItems(envelopeBodies);
      expect(attributeValues(completed)).toMatchObject({
        command: "convert",
        targets_declared: true,
        validate_installed_binary: true,
        target_opentofu: ">=1.7.0",
      });
      expect(completed.attributes.target_terraform).toBeUndefined();
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

  describe("getBinaryAttributes", () => {
    it.each([
      ["1.10.0-alpha20250101", "1.10.0"],
      ["1.2.3-LEAK-WRAPPER-hostname.corp.example.com+LEAK-BUILD", "1.2.3"],
      ["9.9.9-LEAK-UNKNOWN/Users/x/LEAK-SECRET-DIR", "9.9.9"],
    ])(
      "reduces the probed version %p to its release %p",
      async (version, release) => {
        await expect(
          getBinaryAttributes(Promise.resolve({ name: "terraform", version })),
        ).resolves.toEqual({ binary: "terraform", binary_version: release });
      },
    );

    it("omits binary_version when the probed version has no release prefix", async () => {
      await expect(
        getBinaryAttributes(
          Promise.resolve({ name: "opentofu", version: "v1.2" }),
        ),
      ).resolves.toEqual({ binary: "opentofu" });
    });

    it("sends no version for an unrecognised product: a wrapper's output has no product version line", async () => {
      seedTerraformCliProbeForTests(
        Promise.resolve(
          "connected to 10.0.0.1 as LEAK-USER (wrapper 3.4.5)\nTerraform v1.9.0\n",
        ),
      );
      const attributes = await getBinaryAttributes();
      expect(attributes).toEqual({ binary: "unknown" });
      expect(JSON.stringify(attributes)).not.toContain("10.0.0");
    });

    it("reports unknown when the probe does not settle in time", async () => {
      // a hung or interactive `terraform version` must never delay a
      // command; the race has a 1500 ms ceiling in production
      const hung = new Promise<never>(() => {});
      await expect(getBinaryAttributes(hung, 10)).resolves.toEqual({
        binary: "unknown",
      });
    });
  });

  describe("getProjectTargetAttributes", () => {
    it("reads declared targets and the validation flag", () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        targetVersions: { opentofu: "~1.8" },
        validateInstalledBinary: true,
      });
      expect(getProjectTargetAttributes(workdir)).toEqual({
        targets_declared: true,
        validate_installed_binary: true,
        target_opentofu: ">=1.8.0 <1.9.0-0",
      });
    });

    it.each([[{}], [{ targetVersions: "nope" }], [{ targetVersions: [] }]])(
      "falls back to the defaults for %j",
      (config) => {
        fs.writeJsonSync(path.join(workdir, "cdktf.json"), config);
        expect(getProjectTargetAttributes(workdir)).toEqual({
          targets_declared: false,
          validate_installed_binary: false,
          ...DEFAULT_TARGET_VERSIONS_AS_ATTRIBUTES,
        });
      },
    );

    it("does not throw without a cdktf.json", () => {
      expect(getProjectTargetAttributes(workdir).targets_declared).toBe(false);
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
