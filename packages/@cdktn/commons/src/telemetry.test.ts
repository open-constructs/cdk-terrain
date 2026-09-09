// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as Sentry from "@sentry/node";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  sendTelemetry,
  classifyModuleSource,
  normalizeProviderSource,
  getBinaryAttributes,
  getProjectTargetAttributes,
  getUsageTelemetryConsent,
  isUsageTelemetryEnabled,
  setProjectTargetAttributes,
  setUsageTelemetryEnabled,
} from "./telemetry";
import { DEFAULT_TARGET_VERSIONS } from "./config";

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
  });

  afterEach(async () => {
    setUsageTelemetryEnabled(undefined);
    setProjectTargetAttributes(undefined);
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

    it("stamps environment, binary and target attributes on every command metric", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
        sendUsageTelemetry: true,
        targetVersions: { terraform: ">=1.9.0", opentofu: ">=1.8.0" },
        validateInstalledBinary: true,
      });
      initSentryWithCapturingTransport();

      await sendTelemetry("synth", { totalTime: 1, language: "typescript" });
      await sendTelemetry("synth", { error: true, synthOrigin: "watch" });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      const metrics = [
        "cli.command.invoked",
        "cli.synth.duration",
        "cli.command.error",
      ].map((name) => items.find((i) => i.name === name)!);

      for (const metric of metrics) {
        expect(metric).toBeDefined();
        const values = Object.fromEntries(
          Object.entries(metric.attributes).map(([k, v]) => [k, v.value]),
        );
        expect(values).toMatchObject({
          os: process.platform,
          arch: process.arch,
          target_terraform: ">=1.9.0",
          target_opentofu: ">=1.8.0",
          targets_declared: true,
          validate_installed_binary: true,
          // the SDK stamps the release set in Sentry.init on every metric,
          // so the CLI version needs no attribute of its own
          "sentry.release": "cdktn-cli-test",
        });
        expect(["terraform", "opentofu", "unknown", "missing"]).toContain(
          values.binary,
        );
        if (values.binary === "terraform" || values.binary === "opentofu") {
          expect(values.binary_version).toMatch(/^\d+\.\d+\.\d+/);
        }
        for (const forbidden of [
          "stackName",
          "hostname",
          "message",
          "projectId",
        ]) {
          expect(values).not.toHaveProperty(forbidden);
        }
      }
      expect(metrics[2].attributes.synth_origin.value).toBe("watch");
    });

    it("falls back to the default target ranges outside a project", async () => {
      initSentryWithCapturingTransport();

      await sendTelemetry("convert", {});
      expect(await Sentry.flush(2000)).toBe(true);

      const invoked = parseMetricItems(envelopeBodies).find(
        (i) => i.name === "cli.command.invoked",
      )!;
      expect(invoked.attributes.targets_declared.value).toBe(false);
      expect(invoked.attributes.validate_installed_binary.value).toBe(false);
      expect(invoked.attributes.target_terraform.value).toBe(
        DEFAULT_TARGET_VERSIONS.terraform,
      );
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

      await sendTelemetry("convert", {});
      expect(await Sentry.flush(2000)).toBe(true);

      const invoked = parseMetricItems(envelopeBodies).find(
        (i) => i.name === "cli.command.invoked",
      )!;
      expect(invoked.attributes.target_opentofu.value).toBe(">=1.7.0");
      expect(invoked.attributes.target_terraform).toBeUndefined();
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

  describe("sendTelemetry payload mapping", () => {
    function attributeValues(item: MetricItem) {
      return Object.fromEntries(
        Object.entries(item.attributes).map(([k, v]) => [k, v.value]),
      );
    }

    beforeEach(() => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: true,
      });
      initSentryWithCapturingTransport();
    });

    it("forwards only allow-listed scalars: an unknown object-valued key is never serialized", async () => {
      await sendTelemetry("convert", {
        language: "python",
        numberOfProviders: 2,
        numberOfModules: 1,
        convertedLines: 42,
        resources: { aws: { s3_bucket: 3 } },
        data: { aws: { caller_identity: 1 } },
        somethingElse: "not listed",
        error: false,
      });
      expect(await Sentry.flush(2000)).toBe(true);

      const invoked = parseMetricItems(envelopeBodies).find(
        (i) => i.name === "cli.command.invoked",
      )!;
      const values = attributeValues(invoked);
      expect(values).toMatchObject({
        language: "python",
        provider_count: 2,
        module_count: 1,
        converted_lines: 42,
      });
      expect(values).not.toHaveProperty("resources");
      expect(values).not.toHaveProperty("data");
      expect(values).not.toHaveProperty("somethingElse");
      expect(values).not.toHaveProperty("error");
      expect(JSON.stringify(values)).not.toContain("s3_bucket");
    });

    it("counts get targets per provider/module and puts only totals on the command metric", async () => {
      await sendTelemetry("get", {
        language: "typescript",
        targets: [
          { type: "provider", source: "registry.terraform.io/hashicorp/aws" },
          { type: "provider", source: "Kreuzwerker/Docker" },
          { type: "module", source: "terraform-aws-modules/vpc/aws" },
          { type: "module", source: "./modules/secret-name" },
        ],
      });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      const invoked = items.find((i) => i.name === "cli.command.invoked")!;
      expect(attributeValues(invoked)).toMatchObject({
        provider_count: 2,
        module_count: 2,
      });
      expect(invoked.attributes).not.toHaveProperty("targets");

      const providers = items
        .filter((i) => i.name === "cli.get.provider")
        .map((i) => attributeValues(i).provider);
      expect(providers).toEqual(["hashicorp/aws", "kreuzwerker/docker"]);

      const modules = items
        .filter((i) => i.name === "cli.get.module")
        .map((i) => attributeValues(i).module);
      expect(modules).toEqual(["terraform-aws-modules/vpc/aws", "local"]);
      expect(JSON.stringify(items)).not.toContain("secret-name");
    });

    it("maps init to template/is_remote attributes and per-provider counts", async () => {
      await sendTelemetry("init", {
        language: "go",
        template: "go",
        isRemote: false,
        projectId: "should-not-be-sent",
        addedProviders: ["aws@~>5.0", "hashicorp/random"],
      });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      const invoked = items.find((i) => i.name === "cli.command.invoked")!;
      expect(attributeValues(invoked)).toMatchObject({
        template: "go",
        is_remote: false,
        provider_count: 2,
      });
      expect(invoked.attributes).not.toHaveProperty("projectId");
      expect(
        items
          .filter((i) => i.name === "cli.init.provider")
          .map((i) => attributeValues(i).provider),
      ).toEqual(["hashicorp/aws", "hashicorp/random"]);
    });

    it("forwards the watch event", async () => {
      await sendTelemetry("watch", { event: "start" });
      expect(await Sentry.flush(2000)).toBe(true);

      const invoked = parseMetricItems(envelopeBodies).find(
        (i) => i.name === "cli.command.invoked",
      )!;
      expect(invoked.attributes.event.value).toBe("start");
    });
  });

  describe("source normalization", () => {
    it.each([
      ["aws", "hashicorp/aws"],
      ["aws@~>5.0", "hashicorp/aws"],
      ["Hashicorp/AWS@5.1.0", "hashicorp/aws"],
      ["registry.terraform.io/hashicorp/aws", "hashicorp/aws"],
      ["registry.opentofu.org/hashicorp/aws", "hashicorp/aws"],
      ["kreuzwerker/docker", "kreuzwerker/docker"],
    ])("normalizeProviderSource(%s) -> %s", (input, expected) => {
      expect(normalizeProviderSource(input)).toBe(expected);
    });

    it.each([
      ["terraform-aws-modules/vpc/aws", "terraform-aws-modules/vpc/aws"],
      ["Terraform-AWS-Modules/VPC/aws", "terraform-aws-modules/vpc/aws"],
      ["app.terraform.io/my-org/vpc/aws", "private-registry"],
      ["./modules/vpc", "local"],
      ["../shared/vpc", "local"],
      ["/abs/path/vpc", "local"],
      ["git::https://github.com/org/repo.git", "git"],
      ["git@github.com:org/repo.git", "git"],
      ["github.com/org/repo", "git"],
      ["https://example.com/vpc.zip", "git"],
      ["not-a-module", "other"],
    ])("classifyModuleSource(%s) -> %s", (input, expected) => {
      expect(classifyModuleSource(input)).toBe(expected);
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

    it("emits when the flag is unset (default-on)", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
      });
      initSentryWithCapturingTransport();

      await sendTelemetry("get", { language: "typescript" });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      expect(items.some((i) => i.name === "cli.command.invoked")).toBe(true);
    });

    it("emits when no cdktf.json exists (no-project commands, default-on)", async () => {
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

  describe("getBinaryAttributes", () => {
    it("maps the probe result to binary and binary_version", async () => {
      await expect(
        getBinaryAttributes(
          Promise.resolve({ name: "opentofu", version: "1.8.1" }),
        ),
      ).resolves.toEqual({ binary: "opentofu", binary_version: "1.8.1" });
      await expect(
        getBinaryAttributes(Promise.resolve({ name: "missing" })),
      ).resolves.toEqual({ binary: "missing" });
    });

    it("reports unknown when the probe does not settle in time", async () => {
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
        target_opentofu: "~1.8",
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
