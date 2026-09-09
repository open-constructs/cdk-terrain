// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as Sentry from "@sentry/node";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import ciInfo from "ci-info";
import {
  sendTelemetry,
  classifyModuleSource,
  classifyProviderBinding,
  getGeneratedProviderSources,
  normalizeProviderSource,
  getBinaryAttributes,
  getProjectTargetAttributes,
  getUsageTelemetryConsent,
  setProjectTargetAttributes,
  setUsageTelemetryEnabled,
} from "./telemetry";
import { DEFAULT_TARGET_VERSIONS } from "./config";
import { Errors, commandErrorType } from "./errors";

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

// Mirrors recordEnvelope in tools/sentry-sink.mjs: an envelope-format change
// is fixed in both.
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
    (globalThis as any)[Symbol.for("cdktn.terraformCli")] = Promise.resolve(
      "Terraform v1.9.0\non darwin_arm64\n",
    );
  });

  afterEach(async () => {
    setUsageTelemetryEnabled(undefined);
    setProjectTargetAttributes(undefined);
    delete (globalThis as any)[Symbol.for("cdktn.terraformCli")];
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
    it("stamps environment, binary and target attributes on every command metric", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
        sendUsageTelemetry: true,
        targetVersions: { terraform: ">=1.9.0", opentofu: ">=1.8.0" },
        validateInstalledBinary: true,
      });
      process.env.SENTRY_ENVIRONMENT = "LEAK-ENV-SENTRY";
      initSentryWithCapturingTransport();

      await sendTelemetry("synth", { totalTime: 1234, language: "typescript" });
      await sendTelemetry("synth", { error: true, synthOrigin: "watch" });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      // a run is counted once: as invoked or, for an error payload, as error
      expect(items.map((i) => i.name)).toEqual([
        "cli.command.invoked",
        "cli.synth.duration",
        "cli.command.error",
      ]);
      const [invoked, duration, error] = items;

      for (const metric of items) {
        const values = attributeValues(metric);
        expect(values).toMatchObject({
          os: process.platform,
          arch: process.arch,
          binary: "terraform",
          binary_version: "1.9.0",
          target_terraform: ">=1.9.0",
          target_opentofu: ">=1.8.0",
          targets_declared: true,
          validate_installed_binary: true,
          ci: ciInfo.isCI ? ciInfo.name || "unknown" : false,
          // the SDK stamps the release set in Sentry.init on every metric,
          // so the CLI version needs no attribute of its own
          "sentry.release": "cdktn-cli-test",
          "sentry.environment": "production",
        });
        for (const forbidden of [
          "stackName",
          "hostname",
          "message",
          "projectId",
        ]) {
          expect(values).not.toHaveProperty(forbidden);
        }
      }
      expect(attributeValues(invoked).language).toBe("typescript");
      expect(duration.type).toBe("distribution");
      expect(duration.value).toBe(1234);
      expect(attributeValues(error)).toMatchObject({
        error_type: "unexpected",
        synth_origin: "watch",
      });
      expect(envelopeBodies.join("\n")).not.toContain("LEAK-ENV-SENTRY");
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

    it.each([
      ["Usage", "Usage"],
      ["External", "External"],
      ["Internal", "Internal"],
      ["unexpected", "unexpected"],
      ["Something Else", "unexpected"],
      [42, "unexpected"],
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

    it("never sends the hostname, username or working directory in any envelope", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: true,
      });
      initSentryWithCapturingTransport();

      await sendTelemetry("synth", { totalTime: 1, language: "typescript" });
      expect(await Sentry.flush(2000)).toBe(true);

      let username: string | undefined;
      try {
        username = os.userInfo().username;
      } catch {
        username = process.env.USER;
      }
      expect(envelopeBodies.length).toBeGreaterThan(0);
      for (const body of envelopeBodies) {
        expect(body).not.toContain(os.hostname());
        if (username) {
          expect(body).not.toContain(username);
        }
        expect(body).not.toContain(process.cwd());
        expect(body).not.toContain(workdir);
      }
    });

    it("forwards exactly the allow-listed attribute set and nothing else from the payload", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
        sendUsageTelemetry: true,
      });
      initSentryWithCapturingTransport();

      await sendTelemetry("synth", {
        totalTime: 5,
        language: "typescript",
        synthOrigin: "watch",
        stackMetadata: [{ stackName: "prod-vpc", backend: "s3" }],
        requiredProviders: [{ aws: { source: "aws" } }],
        stackName: "prod-vpc",
        outdir: "/Users/x/secret",
      });
      expect(await Sentry.flush(2000)).toBe(true);

      const invoked = parseMetricItems(envelopeBodies).find(
        (i) => i.name === "cli.command.invoked",
      )!;
      // the one place that fails when an attribute is added: extend it
      // deliberately, together with the collected-data list in the docs
      expect(Object.keys(invoked.attributes).sort()).toEqual([
        "arch",
        "binary",
        "binary_version",
        "ci",
        "command",
        "language",
        "os",
        // stamped by the SDK: release/environment/serverName from init
        "sentry.environment",
        "sentry.release",
        "sentry.sdk.name",
        "sentry.sdk.version",
        "sentry.timestamp.sequence",
        "server.address",
        "synth_origin",
        "target_opentofu",
        "target_terraform",
        "targets_declared",
        "validate_installed_binary",
      ]);
      expect(invoked.attributes.binary_version.value).toBe("1.9.0");
      expect(invoked.attributes["server.address"].value).toBe("cdktn-cli");
      const bytes = envelopeBodies.join("\n");
      expect(bytes).not.toContain("prod-vpc");
      expect(bytes).not.toContain("/Users/x/secret");
    });
  });

  describe("sendTelemetry payload mapping", () => {
    beforeEach(() => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: true,
      });
      initSentryWithCapturingTransport();
    });

    it.each([
      [
        "convert",
        { numberOfProviders: 2, numberOfModules: 1, convertedLines: 42 },
        { provider_count: 2, module_count: 1, converted_lines: 42 },
      ],
      [
        "init",
        { template: "go", isRemote: false },
        { template: "go", is_remote: false },
      ],
      ["watch", { event: "start" }, { event: "start" }],
      ["synth", { synthOrigin: "watch" }, { synth_origin: "watch" }],
    ])(
      "maps the %s scalars %j to the attributes %j",
      async (command, payload, expected) => {
        await sendTelemetry(command, payload);
        expect(await Sentry.flush(2000)).toBe(true);

        const invoked = parseMetricItems(envelopeBodies).find(
          (i) => i.name === "cli.command.invoked",
        )!;
        expect(attributeValues(invoked)).toMatchObject(expected);
      },
    );

    it("forwards only allow-listed scalars: an unknown object-valued key is never serialized", async () => {
      await sendTelemetry("convert", {
        language: "python",
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
      expect(values).toMatchObject({ language: "python", converted_lines: 42 });
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

    it("counts init providers per provider and puts only the total on the command metric", async () => {
      await sendTelemetry("init", {
        language: "go",
        projectId: "should-not-be-sent",
        addedProviders: ["aws@~>5.0", "hashicorp/random"],
      });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      const invoked = items.find((i) => i.name === "cli.command.invoked")!;
      expect(attributeValues(invoked).provider_count).toBe(2);
      expect(invoked.attributes).not.toHaveProperty("projectId");
      expect(
        items
          .filter((i) => i.name === "cli.init.provider")
          .map((i) => attributeValues(i).provider),
      ).toEqual(["hashicorp/aws", "hashicorp/random"]);
    });
  });

  describe("stack metrics", () => {
    // one JSON-synthesized stack the way the library writes it: metadata
    // carries the stack name and resource ids (imports/moved), overrides
    // are keyed by schema type, module overrides by source
    const stackMetadata = [
      {
        version: "0.21.0",
        stackName: "SECRET-STACK-NAME",
        backend: "s3",
        overrides: {
          stack: ["terraform.required_version"],
          aws_s3_bucket: ["tags", "region"],
          "module.../secret-path/vpc": ["providers"],
        },
        imports: { aws_s3_bucket: ["secret-resource-id"] },
        moved: {
          aws_s3_bucket: ["secret-resource-id"],
          aws_iam_role: ["secret-resource-id"],
        },
      },
      {
        version: "0.21.0",
        stackName: "SECRET-STACK-NAME-2",
        backend: "remote",
        cloud: "tfc",
      },
    ];
    const requiredProviders = [
      {
        aws: { source: "aws", version: "~> 5.0" },
        docker: {
          source: "registry.terraform.io/kreuzwerker/docker",
          version: "3.0.2",
        },
        google: { source: "hashicorp/google", version: "x".repeat(100) },
      },
      {
        random: { source: "hashicorp/random" },
        vault: {
          source: "tfe.corp.example.com/acme-org/vault",
          version: "~> 3.0",
        },
      },
    ];

    beforeEach(() => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: true,
        terraformProviders: [
          "aws@~>5.0",
          { name: "docker", source: "kreuzwerker/docker", version: "3.0.2" },
        ],
      });
      initSentryWithCapturingTransport();
    });

    it("counts one cli.stack per stack with backend, cloud, library version and group sizes", async () => {
      await sendTelemetry("deploy", {
        language: "typescript",
        stackMetadata,
        requiredProviders,
        failedStackCount: 0,
      });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      const stacks = items
        .filter((i) => i.name === "cli.stack")
        .map(attributeValues);
      expect(stacks).toHaveLength(2);
      expect(stacks[0]).toMatchObject({
        command: "deploy",
        language: "typescript",
        backend: "s3",
        cloud: false,
        library_version: "0.21.0",
        override_count: 4,
        import_count: 1,
        moved_count: 2,
        os: process.platform,
        "sentry.release": "cdktn-cli-test",
      });
      expect(stacks[1]).toMatchObject({
        backend: "remote",
        cloud: true,
        override_count: 0,
        import_count: 0,
        moved_count: 0,
      });
      expect(items.some((i) => i.name === "cli.stack.failed")).toBe(false);
      expect(items.some((i) => i.name === "cli.command.invoked")).toBe(true);
    });

    it("counts overrides per resource type, reducing module sources to their kind", async () => {
      await sendTelemetry("synth", { stackMetadata, requiredProviders });
      expect(await Sentry.flush(2000)).toBe(true);

      const overrides = parseMetricItems(envelopeBodies)
        .filter((i) => i.name === "cli.stack.override")
        .map((i) => {
          const { resource_type, override_count } = attributeValues(i);
          return [resource_type, override_count];
        });
      expect(overrides).toEqual([
        ["stack", 1],
        ["aws_s3_bucket", 2],
        ["module.local", 1],
      ]);
    });

    it("counts required providers with normalized source, validated constraint and binding", async () => {
      await sendTelemetry("diff", { stackMetadata, requiredProviders });
      expect(await Sentry.flush(2000)).toBe(true);

      const providers = parseMetricItems(envelopeBodies)
        .filter((i) => i.name === "cli.stack.provider")
        .map(attributeValues);
      expect(providers.map((p) => p.provider)).toEqual([
        "hashicorp/aws",
        "kreuzwerker/docker",
        "hashicorp/google",
        "hashicorp/random",
        "private-registry",
      ]);
      expect(providers.map((p) => p.binding)).toEqual([
        "generated",
        "generated",
        "prebuilt",
        "prebuilt",
        "prebuilt",
      ]);
      expect(providers[0].version_constraint).toBe("~> 5.0");
      expect(providers[2].version_constraint).toBe("invalid");
      expect(providers[3]).not.toHaveProperty("version_constraint");
    });

    it("counts failed stacks and never serializes their failure messages", async () => {
      await sendTelemetry("destroy", {
        stackMetadata,
        requiredProviders,
        failedStackCount: 2,
        failedStacks: ["failed to destroy SECRET-STACK-NAME: /Users/x/state"],
      });
      expect(await Sentry.flush(2000)).toBe(true);

      const failed = parseMetricItems(envelopeBodies).find(
        (i) => i.name === "cli.stack.failed",
      )!;
      expect(failed.value).toBe(2);
      expect(failed.attributes.command.value).toBe("destroy");
      expect(envelopeBodies.join("\n")).not.toContain("failed to destroy");
      expect(envelopeBodies.join("\n")).not.toContain("/Users/x");
    });

    it("never serializes stack names, resource ids or module paths", async () => {
      await sendTelemetry("deploy", {
        language: "typescript",
        stackMetadata,
        requiredProviders,
        failedStackCount: 1,
      });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      const overrideCount = Object.keys(stackMetadata[0].overrides!).length;
      const providerCount = requiredProviders.reduce(
        (total, providers) => total + Object.keys(providers).length,
        0,
      );
      // one cli.stack per stack, one override / provider metric per entry,
      // plus the single cli.stack.failed count
      expect(items.filter((i) => i.name.startsWith("cli.stack")).length).toBe(
        stackMetadata.length + overrideCount + providerCount + 1,
      );
      for (const item of items) {
        for (const forbidden of [
          "stackName",
          "stack_name",
          "imports",
          "moved",
        ]) {
          expect(item.attributes).not.toHaveProperty(forbidden);
        }
      }
      const bytes = envelopeBodies.join("\n");
      expect(bytes).not.toContain("SECRET-STACK-NAME");
      expect(bytes).not.toContain("secret-resource-id");
      expect(bytes).not.toContain("secret-path");
      expect(bytes).not.toContain("tfe.corp.example.com");
      expect(bytes).not.toContain("acme-org");
    });

    it("emits no cli.stack.* metric when usage telemetry is off", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: false,
      });

      await sendTelemetry("deploy", {
        stackMetadata,
        requiredProviders,
        failedStackCount: 1,
      });
      await Sentry.flush(2000);

      expect(parseMetricItems(envelopeBodies)).toHaveLength(0);
    });

    // a throw inside a payload handler is swallowed by sendTelemetry's catch
    // and would skip the command metric for the whole run
    it("tolerates malformed metadata entries", async () => {
      await sendTelemetry("synth", {
        stackMetadata: [null, "nope", { overrides: "nope", imports: [] }],
        requiredProviders: [undefined, { aws: "nope" }],
      });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      expect(items.filter((i) => i.name === "cli.stack")).toHaveLength(3);
      expect(items.filter((i) => i.name === "cli.stack.override")).toHaveLength(
        0,
      );
      const provider = items.find((i) => i.name === "cli.stack.provider")!;
      expect(attributeValues(provider)).toMatchObject({
        provider: "hashicorp/aws",
        binding: "generated",
      });
      expect(items.some((i) => i.name === "cli.command.invoked")).toBe(true);
    });

    it.each([
      ["init", { addedProviders: [null, 42, "aws"] }, "cli.init.provider"],
      [
        "get",
        {
          targets: [{ type: "provider" }, null, { type: "module", source: 7 }],
        },
        "cli.get.provider",
      ],
    ])(
      "still counts the %s command with malformed %j entries",
      async (command, payload, metric) => {
        await sendTelemetry(command, payload);
        expect(await Sentry.flush(2000)).toBe(true);

        const items = parseMetricItems(envelopeBodies);
        const invoked = items.find((i) => i.name === "cli.command.invoked")!;
        expect(invoked).toBeDefined();
        expect(items.filter((i) => i.name === metric)).toHaveLength(
          command === "init" ? 1 : 0,
        );
        expect(attributeValues(invoked).provider_count).toBe(
          command === "init" ? 1 : 0,
        );
      },
    );
  });

  describe("attribute validation", () => {
    beforeEach(() => {
      initSentryWithCapturingTransport();
    });

    it("omits a language that is not one of the supported ones", async () => {
      await sendTelemetry("convert", { language: "rust; DROP TABLE" });
      expect(await Sentry.flush(2000)).toBe(true);

      const invoked = parseMetricItems(envelopeBodies).find(
        (i) => i.name === "cli.command.invoked",
      )!;
      expect(invoked.attributes).not.toHaveProperty("language");
      expect(envelopeBodies.join("\n")).not.toContain("DROP TABLE");
    });

    it.each([
      ["synth", { synthOrigin: "watch" }, "synth_origin", "watch"],
      ["synth", { synthOrigin: "/Users/x" }, "synth_origin", undefined],
      ["watch", { event: "start" }, "event", "start"],
      ["watch", { event: "stopped-by-user" }, "event", undefined],
      ["init", { isRemote: true }, "is_remote", true],
      ["init", { isRemote: "true" }, "is_remote", undefined],
      ["init", { template: "go" }, "template", "go"],
      ["init", { template: 7 }, "template", undefined],
      ["convert", { convertedLines: 42 }, "converted_lines", 42],
      ["convert", { convertedLines: "42" }, "converted_lines", undefined],
      ["convert", { convertedLines: NaN }, "converted_lines", undefined],
    ])(
      "%s: %j forwards %s as %j",
      async (command, payload, attribute, expected) => {
        await sendTelemetry(command, payload);
        expect(await Sentry.flush(2000)).toBe(true);

        const invoked = parseMetricItems(envelopeBodies).find(
          (i) => i.name === "cli.command.invoked",
        )!;
        if (expected === undefined) {
          expect(invoked.attributes).not.toHaveProperty(attribute);
        } else {
          expect(attributeValues(invoked)[attribute]).toBe(expected);
        }
      },
    );

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

    it.each([
      [">= 1.2, < 2.0", ">= 1.2, < 2.0"],
      ["~> 5.0", "~> 5.0"],
      ["= 1.0", "= 1.0"],
      ["!= 1.2.3", "!= 1.2.3"],
      ["1.2.3", "1.2.3"],
      ["  >= 1.0 ,  < 2.0  ", ">= 1.0, < 2.0"],
      ["~>5.0,!=5.1.0", "~> 5.0, != 5.1.0"],
      ["1.0.0-beta.1", "invalid"],
      [">= 1.0.0-LEAK-CONSTRAINT-PRERELEASE.corp", "invalid"],
      ["1.2.3-acme.internal", "invalid"],
      ["1.2.3+build.host", "invalid"],
      ["latest", "invalid"],
      [">= 1.2 || < 2.0", "invalid"],
      ["~> 5.0 # /Users/x", "invalid"],
      ["1." + "1.".repeat(40), "invalid"],
    ])(
      "forwards the provider constraint %p as %p",
      async (version, expected) => {
        await sendTelemetry("synth", {
          stackMetadata: [{}],
          requiredProviders: [{ aws: { source: "aws", version } }],
        });
        expect(await Sentry.flush(2000)).toBe(true);

        const provider = parseMetricItems(envelopeBodies).find(
          (i) => i.name === "cli.stack.provider",
        )!;
        expect(attributeValues(provider).version_constraint).toBe(expected);
      },
    );

    it("reduces a backend outside the built-in kinds and override keys outside the type grammar to other", async () => {
      await sendTelemetry("synth", {
        stackMetadata: [
          {
            version: "0.21.0+build." + "x".repeat(40),
            backend: "s3 bucket=/Users/x/state",
            overrides: {
              aws_s3_bucket: ["tags"],
              terraform_remote_state: ["backend"],
              "module.terraform-aws-modules/vpc/aws": ["providers"],
              "resource with spaces /Users/x": ["tags"],
              AWS_S3_Bucket: ["tags"],
              ["aws_" + "x".repeat(70)]: ["tags"],
            },
          },
          { version: "dev-/Users/x", backend: "S3" },
        ],
      });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      const stacks = items
        .filter((i) => i.name === "cli.stack")
        .map(attributeValues);
      // build metadata is stripped like binary_version; a version without a
      // MAJOR.MINOR.PATCH prefix yields no attribute at all
      expect(stacks[0]).toMatchObject({
        backend: "other",
        library_version: "0.21.0",
      });
      expect(stacks[1]).toMatchObject({ backend: "other" });
      expect(stacks[1]).not.toHaveProperty("library_version");
      expect(
        items
          .filter((i) => i.name === "cli.stack.override")
          .map((i) => attributeValues(i).resource_type),
      ).toEqual([
        "aws_s3_bucket",
        "terraform_remote_state",
        "module.terraform-aws-modules/vpc/aws",
        "other",
        "other",
        "other",
      ]);
      expect(envelopeBodies.join("\n")).not.toContain("/Users/x");
    });

    it.each(["local", "remote", "cloud", "s3", "gcs", "azurerm", "kubernetes"])(
      "forwards the %s backend kind as-is",
      async (backend) => {
        await sendTelemetry("synth", { stackMetadata: [{ backend }] });
        expect(await Sentry.flush(2000)).toBe(true);

        expect(
          attributeValues(
            parseMetricItems(envelopeBodies).find(
              (i) => i.name === "cli.stack",
            )!,
          ).backend,
        ).toBe(backend);
      },
    );
  });

  describe("provider binding classification", () => {
    it("reads string and object terraformProviders entries as identities", () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        terraformProviders: [
          "aws@~>5.0",
          "hashicorp/random@3.6.0",
          "registry.terraform.io/kreuzwerker/docker",
          { name: "google", source: "hashicorp/google", version: "~> 5.0" },
          { name: "azurerm" },
          { version: "1.0.0" },
          42,
          "TFE.corp.example.com/acme-org/vault@~>3.0",
        ],
      });
      expect(getGeneratedProviderSources(workdir)).toEqual([
        "hashicorp/aws",
        "hashicorp/random",
        "kreuzwerker/docker",
        "hashicorp/google",
        "hashicorp/azurerm",
        "tfe.corp.example.com/acme-org/vault",
      ]);
    });

    it.each([[{}], [{ terraformProviders: "aws" }]])(
      "returns no sources for %j",
      (config) => {
        fs.writeJsonSync(path.join(workdir, "cdktf.json"), config);
        expect(getGeneratedProviderSources(workdir)).toEqual([]);
      },
    );

    it("returns no sources without a cdktf.json", () => {
      expect(getGeneratedProviderSources(workdir)).toEqual([]);
    });

    it.each([
      ["aws", "generated"],
      ["registry.terraform.io/hashicorp/aws", "generated"],
      ["Hashicorp/AWS", "generated"],
      ["kreuzwerker/docker", "generated"],
      ["hashicorp/google", "prebuilt"],
      ["tfe.corp.example.com/acme-org/vault", "generated"],
      // another private source is not the generated one, even though both
      // reach the metric as "private-registry"
      ["tfe.corp.example.com/other-org/vault", "prebuilt"],
      ["./leak-provider", "prebuilt"],
    ])("classifies %s as %s", (source, expected) => {
      const generated = [
        "hashicorp/aws",
        "kreuzwerker/docker",
        "tfe.corp.example.com/acme-org/vault",
      ];
      expect(classifyProviderBinding(source, generated)).toBe(expected);
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
      ["tfe.corp.example.com/acme-org/aws", "private-registry"],
      ["registry.acme.internal/platform/vault@~>3.0", "private-registry"],
      ["localhost:8080/acme/aws", "private-registry"],
      ["./leak-provider", "other"],
      ["../leak/provider", "other"],
      ["/abs/leak/provider", "other"],
      ["a/b/c", "other"],
      ["", "other"],
      ["registry.terraform.io/hashicorp", "other"],
    ])("normalizeProviderSource(%s) -> %s", (input, expected) => {
      expect(normalizeProviderSource(input)).toBe(expected);
    });

    it.each([
      ["terraform-aws-modules/vpc/aws", "terraform-aws-modules/vpc/aws"],
      ["Terraform-AWS-Modules/VPC/aws", "terraform-aws-modules/vpc/aws"],
      ["Terraform-AWS-Modules/VPC/aws?ref=v5.0.0", "other"],
      ["app.terraform.io/my-org/vpc/aws", "private-registry"],
      ["./modules/vpc", "local"],
      ["../shared/vpc", "local"],
      ["/abs/path/vpc", "local"],
      ["git::https://github.com/org/repo.git", "git"],
      ["git@github.com:org/repo.git", "git"],
      ["github.com/org/repo", "git"],
      ["https://example.com/vpc.zip", "git"],
      ["s3::https://s3-eu-west-1.amazonaws.com/leak-bucket/vpc.zip", "git"],
      ["s3-eu-west-1.amazonaws.com/leak-bucket/vpc.zip", "git"],
      ["leak-bucket.s3.amazonaws.com/leak-dir/vpc.zip", "git"],
      ["gcs::https://www.googleapis.com/storage/v1/leak-bucket/vpc", "git"],
      ["www.googleapis.com/storage/v1/leak-bucket/vpc", "git"],
      ["hg::http://example.com/leak-repo", "git"],
      ["gitlab.com/leak-org/leak-repo", "other"],
      ["example.com/leak/mod.zip", "other"],
      ["~/leak-home/mod", "other"],
      ["localhost:8080/leak-org/mod", "other"],
      ["terraform-aws-modules/vpc/aws//modules/leak-sub", "other"],
      ["not-a-module", "other"],
    ])("classifyModuleSource(%s) -> %s", (input, expected) => {
      expect(classifyModuleSource(input)).toBe(expected);
    });
  });

  describe("sendTelemetry gating", () => {
    // CHECKPOINT_DISABLE > the decision captured at command start >
    // sendUsageTelemetry in cdktf.json (absent file = flag unset) > on
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

        await sendTelemetry("convert", {});
        await Sentry.flush(2000);

        const items = parseMetricItems(envelopeBodies);
        expect(items.some((i) => i.name === "cli.command.invoked")).toBe(emits);
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

    it.each([
      ["sendUsageTelemetry: false", { flag: false, env: undefined }],
      ["CHECKPOINT_DISABLE", { flag: true, env: "1" }],
    ])("is suppressed by %s", async (_case, { flag, env }) => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: flag,
      });
      initSentryWithCapturingTransport();
      if (env !== undefined) {
        process.env.CHECKPOINT_DISABLE = env;
      }

      Errors.Internal("boom");
      await Sentry.flush(2000);

      expect(parseMetricItems(envelopeBodies)).toHaveLength(0);
    });

    it("still returns the typed error when Sentry is not initialized", () => {
      const err = Errors.Usage("plain");
      expect(err.message).toBe("Usage Error: plain");
      expect(err.__type).toBe("Usage");
    });

    it("exposes the scope set for the running command", () => {
      expect(Errors.getScope()).toBe("unknown");
      Errors.setScope("provider add");
      expect(Errors.getScope()).toBe("provider add");
    });
  });

  describe("commandErrorType", () => {
    it.each([
      [Errors.Usage("u"), "Usage"],
      [Errors.External("e"), "External"],
      [Errors.Internal("i"), "Internal"],
      [new Error("plain"), "unexpected"],
      ["raw-string", "unexpected"],
      [undefined, "unexpected"],
      [null, "unexpected"],
    ])("classifies %p as %s", (error, expected) => {
      expect(commandErrorType(error)).toBe(expected);
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
      (globalThis as any)[Symbol.for("cdktn.terraformCli")] = Promise.resolve(
        "connected to 10.0.0.1 as LEAK-USER (wrapper 3.4.5)\nTerraform v1.9.0\n",
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
      [{ sendUsageTelemetry: true }, true],
      [{ sendUsageTelemetry: false }, false],
      // init templates render the flag as a string; a boolean-only check
      // would opt every freshly init'ed project out
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
});
