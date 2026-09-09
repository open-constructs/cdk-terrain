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
  getProjectTargetAttributes,
  getUsageTelemetryConsent,
  normalizePackageManager,
  PACKAGE_MANAGERS,
  setProjectTargetAttributes,
  setUsageTelemetryEnabled,
} from "./telemetry";
import { seedTerraformCliProbeForTests } from "./terraform";
import {
  DEFAULT_TARGET_VERSIONS,
  Language,
  TerraformModuleConstraint,
  TerraformProviderConstraint,
} from "./config";
import {
  ConstructsMakerModuleTarget,
  ConstructsMakerProviderTarget,
} from "./construct-maker-target";
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

// On every metric of a command; the exact set is pinned once, on
// cli.command.completed.
const COMMAND_ATTRIBUTES = [
  "arch",
  "binary",
  "binary_version",
  "ci",
  "command",
  "language",
  "os",
  "package_manager",
  "server.address",
  "target_opentofu",
  "target_terraform",
  "targets_declared",
  "validate_installed_binary",
];

// Each metric of that name as its value plus exactly the attributes it adds
// to the command's, so `toEqual` fails on any attribute that is not listed.
function metrics(items: MetricItem[], name: string): Record<string, any>[] {
  return items
    .filter((item) => item.name === name)
    .map((item) => ({
      value: item.value,
      ...Object.fromEntries(
        Object.entries(attributeValues(item)).filter(
          ([key]) =>
            !key.startsWith("sentry.") && !COMMAND_ATTRIBUTES.includes(key),
        ),
      ),
    }));
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

  async function deliveredItems(): Promise<MetricItem[]> {
    expect(await Sentry.flush(2000)).toBe(true);
    return parseMetricItems(envelopeBodies);
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
      await sendTelemetry("synth", { error: true, synthOrigin: "watch" });
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
        synth_origin: "watch",
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
        synthOrigin: "watch",
        stackMetadata: [{ stackName: "prod-vpc", backend: "s3" }],
        requiredProviders: [{ aws: { source: "aws" } }],
        stackName: "prod-vpc",
        outdir: "/Users/x/secret",
        resources: { aws: { secret_resource: 3 } },
      });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      const invoked = items.find((i) => i.name === "cli.command.invoked")!;
      const completed = items.find((i) => i.name === "cli.command.completed")!;
      const keys = Object.keys(completed.attributes);
      // the start metric carries the base set; the end-of-run scalars ride
      // on completed only
      expect(Object.keys(invoked.attributes).sort()).toEqual(
        keys.filter((key) => key !== "synth_origin").sort(),
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
        "package_manager",
        // server.address is the fixed serverName from init
        "server.address",
        "synth_origin",
        "target_opentofu",
        "target_terraform",
        "targets_declared",
        "validate_installed_binary",
      ]);
      // stamped by the SDK from init; a patch bump may add more of them
      expect(keys).toEqual(
        expect.arrayContaining(["sentry.release", "sentry.environment"]),
      );
      const bytes = envelopeBodies.join("\n");
      expect(bytes).not.toContain("prod-vpc");
      expect(bytes).not.toContain("/Users/x/secret");
      expect(bytes).not.toContain("secret_resource");
    });
  });

  describe("sendTelemetry payload mapping", () => {
    beforeEach(() => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: true,
      });
      initSentryWithCapturingTransport();
    });

    it("counts get targets per normalized provider/module and puts only totals on the command metric", async () => {
      const provider = (constraint: string) =>
        new ConstructsMakerProviderTarget(
          new TerraformProviderConstraint(constraint),
          Language.TYPESCRIPT,
        ).trackingPayload;
      const module = (constraint: string) =>
        new ConstructsMakerModuleTarget(
          new TerraformModuleConstraint(constraint),
          Language.TYPESCRIPT,
        ).trackingPayload;

      await sendTelemetry("get", {
        targets: [
          provider("registry.terraform.io/hashicorp/aws@~> 5.0"),
          provider("Hashicorp/AWS@~> 6.0"),
          provider("Kreuzwerker/Docker"),
          module("terraform-aws-modules/vpc/aws@5.0.0"),
          module("./modules/secret-name"),
        ],
      });

      const items = await deliveredItems();
      const totals = { provider_count: 3, module_count: 2 };
      expect(metrics(items, "cli.command.completed")).toEqual([
        { value: 1, ...totals },
      ]);
      expect(metrics(items, "cli.get.provider")).toEqual([
        { value: 2, provider: "hashicorp/aws", ...totals },
        { value: 1, provider: "kreuzwerker/docker", ...totals },
      ]);
      expect(metrics(items, "cli.get.module")).toEqual([
        { value: 1, module: "local", ...totals },
        { value: 1, module: "terraform-aws-modules/vpc/aws", ...totals },
      ]);
      expect(envelopeBodies.join("\n")).not.toContain("secret-name");
    });

    it("counts init providers per normalized provider and puts only the total on the command metric", async () => {
      await sendTelemetry("init", {
        projectId: "should-not-be-sent",
        addedProviders: [
          "aws@~>5.0",
          "hashicorp/random",
          "registry.terraform.io/hashicorp/aws",
        ],
      });

      const items = await deliveredItems();
      expect(metrics(items, "cli.command.completed")).toEqual([
        { value: 1, provider_count: 3 },
      ]);
      expect(metrics(items, "cli.init.provider")).toEqual([
        { value: 2, provider: "hashicorp/aws", provider_count: 3 },
        { value: 1, provider: "hashicorp/random", provider_count: 3 },
      ]);
      expect(envelopeBodies.join("\n")).not.toContain("should-not-be-sent");
    });

    it.each([
      [
        "get",
        (sources: string[]) => ({
          targets: sources.map((source) => ({ type: "provider", source })),
        }),
        "cli.get.provider",
        { provider_count: 40, module_count: 0 },
      ],
      [
        "init",
        (sources: string[]) => ({ addedProviders: sources }),
        "cli.init.provider",
        { provider_count: 40 },
      ],
    ])(
      "%s folds the providers past 32 into one truncated count",
      async (command, payload, metric, totals) => {
        const sources = Array.from(
          { length: 40 },
          (_, k) => `acme/p${String(k).padStart(2, "0")}`,
        );

        await sendTelemetry(command, payload([...sources].reverse()));

        const items = await deliveredItems();
        expect(metrics(items, metric)).toEqual([
          ...sources
            .slice(0, 32)
            .map((provider) => ({ value: 1, provider, ...totals })),
          { value: 8, truncated: true, ...totals },
        ]);
        expect(metrics(items, "cli.command.completed")).toEqual([
          { value: 1, ...totals },
        ]);
      },
    );

    it("counts the run as completed even when a per-source metric cannot be built", async () => {
      await sendTelemetry("get", {
        targets: [null, { type: "provider", source: 7 }],
      });

      const items = await deliveredItems();
      expect(metrics(items, "cli.command.completed")).toEqual([
        { value: 1, provider_count: 1, module_count: 0 },
      ]);
      expect(metrics(items, "cli.get.provider")).toEqual([]);
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
    const noCounts = { override_count: 0, import_count: 0, moved_count: 0 };

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

    it("delivers no stack, provider or override metric when the project opts out", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        sendUsageTelemetry: false,
      });

      await sendTelemetry("deploy", {
        language: "typescript",
        stackMetadata,
        requiredProviders,
        failedStackCount: 0,
      });

      expect(await deliveredItems()).toEqual([]);
    });

    it("counts stacks by backend, cloud and library version with their group sizes", async () => {
      await sendTelemetry("deploy", {
        language: "typescript",
        stackMetadata,
        requiredProviders,
        failedStackCount: 0,
      });

      const items = await deliveredItems();
      expect(metrics(items, "cli.stack")).toEqual([
        {
          value: 1,
          backend: "remote",
          cloud: true,
          library_version: "0.21.0",
          ...noCounts,
        },
        {
          value: 1,
          backend: "s3",
          cloud: false,
          library_version: "0.21.0",
          override_count: 4,
          import_count: 1,
          moved_count: 2,
        },
      ]);
      for (const stack of items.filter((i) => i.name === "cli.stack")) {
        expect(attributeValues(stack)).toMatchObject({
          command: "deploy",
          language: "typescript",
        });
      }
      expect(items.some((i) => i.name === "cli.stack.failed")).toBe(false);
      expect(items.some((i) => i.name === "cli.command.completed")).toBe(true);
    });

    it("counts overrides per resource type, reducing module sources to their kind", async () => {
      await sendTelemetry("synth", { stackMetadata, requiredProviders });

      expect(metrics(await deliveredItems(), "cli.stack.override")).toEqual([
        { value: 1, resource_type: "aws_s3_bucket", override_count: 2 },
        { value: 1, resource_type: "module.local", override_count: 1 },
        { value: 1, resource_type: "stack", override_count: 1 },
      ]);
    });

    it("counts required providers by normalized source, validated constraint and binding", async () => {
      await sendTelemetry("diff", { stackMetadata, requiredProviders });

      expect(metrics(await deliveredItems(), "cli.stack.provider")).toEqual([
        {
          value: 1,
          provider: "hashicorp/aws",
          version_constraint: "~> 5.0",
          binding: "generated",
        },
        {
          value: 1,
          provider: "hashicorp/google",
          version_constraint: "invalid",
          binding: "prebuilt",
        },
        { value: 1, provider: "hashicorp/random", binding: "prebuilt" },
        {
          value: 1,
          provider: "kreuzwerker/docker",
          version_constraint: "3.0.2",
          binding: "generated",
        },
        {
          value: 1,
          provider: "private-registry",
          version_constraint: "~> 3.0",
          binding: "prebuilt",
        },
      ]);
    });

    it("classifies bindings against the project the command started in, not the current cwd", async () => {
      await startCommandTelemetry("diff");
      const elsewhere = path.join(workdir, "elsewhere");
      fs.mkdirSync(elsewhere);
      fs.writeJsonSync(path.join(elsewhere, "cdktf.json"), {
        terraformProviders: ["google"],
      });
      process.chdir(elsewhere);

      await sendTelemetry("diff", { stackMetadata, requiredProviders });

      expect(
        metrics(await deliveredItems(), "cli.stack.provider").map((p) => [
          p.provider,
          p.binding,
        ]),
      ).toEqual([
        ["hashicorp/aws", "generated"],
        ["hashicorp/google", "prebuilt"],
        ["hashicorp/random", "prebuilt"],
        ["kreuzwerker/docker", "generated"],
        ["private-registry", "prebuilt"],
      ]);
    });

    it.each([3, 300])(
      "sends the same stack events for %d alike stacks, with the stack count as their value",
      async (count) => {
        await sendTelemetry("deploy", {
          stackMetadata: Array.from({ length: count }, (_, i) => ({
            version: "0.21.0",
            stackName: `stack-${i}`,
            backend: "s3",
            overrides: { aws_s3_bucket: ["tags"] },
          })),
          requiredProviders: Array.from({ length: count }, () => ({
            aws: { source: "aws", version: "~> 5.0" },
            random: { source: "hashicorp/random" },
          })),
        });

        const items = await deliveredItems();
        expect(metrics(items, "cli.stack")).toEqual([
          {
            value: count,
            backend: "s3",
            cloud: false,
            library_version: "0.21.0",
            override_count: count,
            import_count: 0,
            moved_count: 0,
          },
        ]);
        expect(metrics(items, "cli.stack.provider")).toEqual([
          {
            value: count,
            provider: "hashicorp/aws",
            version_constraint: "~> 5.0",
            binding: "generated",
          },
          { value: count, provider: "hashicorp/random", binding: "prebuilt" },
        ]);
        expect(metrics(items, "cli.stack.override")).toEqual([
          {
            value: count,
            resource_type: "aws_s3_bucket",
            override_count: count,
          },
        ]);
      },
    );

    it("groups providers on what is sent: spellings and private hosts collapse, constraints do not", async () => {
      await sendTelemetry("synth", {
        stackMetadata: [{}, {}, {}],
        requiredProviders: [
          {
            aws: { source: "aws", version: "~>5.0" },
            vault: { source: "tfe.leak-one.example/leak-org-one/vault" },
          },
          {
            aws: { source: "Hashicorp/AWS", version: "~> 5.0" },
            // a stack counts once per group, however many entries reach it
            vault: { source: "registry.leak-two.example/leak-org-two/vault" },
            consul: { source: "mirror.leak-three.example/leak-org-two/consul" },
          },
          {
            aws: {
              source: "registry.terraform.io/hashicorp/aws",
              version: "~> 5.0",
            },
            aws6: { source: "aws", version: "~> 6.0" },
          },
        ],
      });

      expect(metrics(await deliveredItems(), "cli.stack.provider")).toEqual([
        {
          value: 3,
          provider: "hashicorp/aws",
          version_constraint: "~> 5.0",
          binding: "generated",
        },
        { value: 2, provider: "private-registry", binding: "prebuilt" },
        {
          value: 1,
          provider: "hashicorp/aws",
          version_constraint: "~> 6.0",
          binding: "generated",
        },
      ]);
      expect(envelopeBodies.join("\n")).not.toContain("leak");
    });

    it("sums the group sizes of the stacks in a group and the paths of an override type", async () => {
      await sendTelemetry("synth", {
        stackMetadata: [
          {
            backend: "local",
            overrides: { aws_s3_bucket: ["a", "b", "c"], "bad key 1": ["x"] },
            imports: { aws_s3_bucket: ["id"] },
          },
          {
            backend: "local",
            overrides: {
              aws_s3_bucket: ["a"],
              "bad key 2": ["x"],
              "bad key 3": ["x", "y", "z"],
            },
            moved: { aws_s3_bucket: ["id", "id"] },
          },
        ],
      });

      const items = await deliveredItems();
      expect(metrics(items, "cli.stack")).toEqual([
        {
          value: 2,
          backend: "local",
          cloud: false,
          override_count: 9,
          import_count: 1,
          moved_count: 2,
        },
      ]);
      expect(metrics(items, "cli.stack.override")).toEqual([
        { value: 2, resource_type: "aws_s3_bucket", override_count: 4 },
        { value: 2, resource_type: "other", override_count: 5 },
      ]);
    });

    it("keeps the 32 most required providers and folds the rest into one truncated count", async () => {
      const sources = Array.from(
        { length: 40 },
        (_, k) => `acme/p${String(k).padStart(2, "0")}`,
      );
      // provider k is required by 40 - k stacks
      const requiredByStack = sources.map((_, stack) =>
        Object.fromEntries(
          sources
            .slice(0, sources.length - stack)
            .map((source, k) => [`p${k}`, { source }]),
        ),
      );

      await sendTelemetry("synth", {
        stackMetadata: sources.map(() => ({})),
        requiredProviders: requiredByStack,
      });

      const providers = metrics(await deliveredItems(), "cli.stack.provider");
      expect(providers).toEqual([
        ...sources.slice(0, 32).map((provider, k) => ({
          value: 40 - k,
          provider,
          binding: "prebuilt",
        })),
        { value: 36, truncated: true },
      ]);
      expect(providers.reduce((total, p) => total + p.value, 0)).toBe(820);
    });

    it("keeps the first 32 override types by name on a tie and folds the rest with their paths", async () => {
      const types = Array.from(
        { length: 34 },
        (_, k) => `aws_t${String(k).padStart(2, "0")}`,
      );
      const longer: Record<string, string[]> = {
        aws_t32: ["a", "b"],
        aws_t33: ["a", "b", "c"],
      };
      const paths = (type: string) => longer[type] ?? ["a"];

      await sendTelemetry("synth", {
        stackMetadata: [
          {
            overrides: Object.fromEntries(
              [...types].reverse().map((type) => [type, paths(type)]),
            ),
          },
        ],
      });

      expect(metrics(await deliveredItems(), "cli.stack.override")).toEqual([
        ...types.slice(0, 32).map((resource_type) => ({
          value: 1,
          resource_type,
          override_count: 1,
        })),
        { value: 2, override_count: 5, truncated: true },
      ]);
    });

    it("keeps the 8 largest stack groups and folds the rest with their group sizes", async () => {
      // library version 0.k.0 is used by k + 1 stacks, each with one import
      const stacksOfVersion = (k: number) =>
        Array.from({ length: k + 1 }, () => ({
          version: `0.${k}.0`,
          backend: "s3",
          imports: { aws_s3_bucket: ["id"] },
        }));

      await sendTelemetry("synth", {
        stackMetadata: Array.from({ length: 10 }, (_, k) =>
          stacksOfVersion(k),
        ).flat(),
      });

      const stacks = metrics(await deliveredItems(), "cli.stack");
      expect(stacks).toEqual([
        ...[9, 8, 7, 6, 5, 4, 3, 2].map((k) => ({
          value: k + 1,
          backend: "s3",
          cloud: false,
          library_version: `0.${k}.0`,
          ...noCounts,
          import_count: k + 1,
        })),
        { value: 3, truncated: true, ...noCounts, import_count: 3 },
      ]);
      expect(stacks.reduce((total, s) => total + s.value, 0)).toBe(55);
    });

    it("bounds the stack events of a run whatever the project's shape, in the envelope of the command metric", async () => {
      const forty = Array.from({ length: 40 }, (_, k) => k);

      await sendTelemetry("deploy", {
        stackMetadata: Array.from({ length: 300 }, (_, i) => ({
          version: `1.${i}.0`,
          overrides: Object.fromEntries(
            forty.map((k) => [`aws_type_${k}`, ["tags"]]),
          ),
        })),
        requiredProviders: Array.from({ length: 300 }, () =>
          Object.fromEntries(
            forty.map((k) => [`p${k}`, { source: `acme/p${k}` }]),
          ),
        ),
      });

      const items = await deliveredItems();
      const count = (name: string) => metrics(items, name).length;
      const total = (name: string) =>
        metrics(items, name).reduce((sum, m) => sum + m.value, 0);
      expect([
        count("cli.stack"),
        count("cli.stack.provider"),
        count("cli.stack.override"),
      ]).toEqual([9, 33, 33]);
      expect(total("cli.stack")).toBe(300);
      expect(total("cli.stack.provider")).toBe(300 * 40);
      expect(count("cli.command.completed")).toBe(1);
      expect(envelopeBodies).toHaveLength(1);
    });

    it("leaves the stacks to the command when its synth is nested: only the selected ones, under its name", async () => {
      await startCommandTelemetry("deploy");
      await sendTelemetry("synth", {
        totalTime: 42,
        stackMetadata,
        requiredProviders,
      });
      await sendTelemetry("deploy", {
        stackMetadata: stackMetadata.slice(1),
        requiredProviders: requiredProviders.slice(1),
      });

      const items = await deliveredItems();
      expect(
        items
          .filter((i) => i.name.startsWith("cli.stack"))
          .map((i) => [i.name, attributeValues(i).command, i.value]),
      ).toEqual([
        ["cli.stack", "deploy", 1],
        ["cli.stack.provider", "deploy", 1],
        ["cli.stack.provider", "deploy", 1],
      ]);
      expect(
        items.some(
          (i) =>
            i.name === "cli.synth.duration" &&
            attributeValues(i).command === "synth",
        ),
      ).toBe(true);
    });

    it("reports the stacks of a synth run under synth", async () => {
      await startCommandTelemetry("synth");
      await sendTelemetry("synth", { stackMetadata, requiredProviders });

      const stacks = (await deliveredItems()).filter(
        (i) => i.name === "cli.stack",
      );
      expect(stacks.map((i) => attributeValues(i).command)).toEqual([
        "synth",
        "synth",
      ]);
    });

    it("reports the stacks once per process: a watch session's later deploys add only their failures", async () => {
      await startCommandTelemetry("watch");
      await sendTelemetry("deploy", { stackMetadata, requiredProviders });
      await sendTelemetry("deploy", {
        stackMetadata,
        requiredProviders,
        failedStackCount: 1,
      });

      const items = await deliveredItems();
      expect(metrics(items, "cli.stack")).toHaveLength(2);
      expect(metrics(items, "cli.stack.provider")).toHaveLength(5);
      expect(metrics(items, "cli.stack.override")).toHaveLength(3);
      expect(metrics(items, "cli.stack.failed")).toEqual([{ value: 1 }]);
    });

    it("counts failed stacks and never serializes their failure messages", async () => {
      await sendTelemetry("destroy", {
        stackMetadata,
        requiredProviders,
        failedStackCount: 2,
        failedStacks: ["failed to destroy SECRET-STACK-NAME: /Users/x/state"],
      });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      const failed = items.find((i) => i.name === "cli.stack.failed")!;
      expect(failed.value).toBe(2);
      expect(failed.attributes.command.value).toBe("destroy");
      // the failure thrown next is counted as cli.command.error, not here
      expect(items.some((i) => i.name === "cli.command.completed")).toBe(false);
      expect(envelopeBodies.join("\n")).not.toContain("failed to destroy");
      expect(envelopeBodies.join("\n")).not.toContain("/Users/x");
    });

    it("counts no completed run and no failed stack for a run that failed before any stack did", async () => {
      await sendTelemetry("deploy", {
        stackMetadata,
        requiredProviders,
        failedStackCount: 0,
        runFailed: true,
      });

      const items = await deliveredItems();
      expect(metrics(items, "cli.stack")).toHaveLength(2);
      expect(metrics(items, "cli.stack.failed")).toEqual([]);
      expect(items.some((i) => i.name === "cli.command.completed")).toBe(false);
    });

    it("never serializes stack names, resource ids or module paths", async () => {
      await sendTelemetry("deploy", {
        language: "typescript",
        stackMetadata,
        requiredProviders,
        failedStackCount: 1,
      });

      const items = await deliveredItems();
      // the scan below is over two stacks, three override types, five
      // providers and the failed count
      expect(items.filter((i) => i.name.startsWith("cli.stack"))).toHaveLength(
        11,
      );
      const bytes = envelopeBodies.join("\n");
      expect(bytes).not.toContain("SECRET-STACK-NAME");
      expect(bytes).not.toContain("secret-resource-id");
      expect(bytes).not.toContain("secret-path");
      expect(bytes).not.toContain("tfe.corp.example.com");
      expect(bytes).not.toContain("acme-org");
    });

    // the metadata is read from disk, written by whatever library version
    // the project has
    it("tolerates malformed metadata entries and counts only the real stacks", async () => {
      await sendTelemetry("synth", {
        stackMetadata: [null, "nope", { overrides: "nope", imports: [] }],
        requiredProviders: [undefined, undefined, { aws: "nope" }],
      });

      const items = await deliveredItems();
      expect(metrics(items, "cli.stack")).toEqual([
        { value: 1, backend: "unknown", cloud: false, ...noCounts },
      ]);
      expect(metrics(items, "cli.stack.override")).toEqual([]);
      expect(metrics(items, "cli.stack.provider")).toEqual([
        { value: 1, provider: "hashicorp/aws", binding: "generated" },
      ]);
      expect(items.some((i) => i.name === "cli.command.completed")).toBe(true);
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

    it.each([
      ["synth", { synthOrigin: "watch" }, "synth_origin", "watch"],
      ["synth", { synthOrigin: "/Users/x" }, "synth_origin", undefined],
      ["init", { isRemote: true }, "is_remote", true],
      ["init", { template: "go" }, "template", "go"],
      ["convert", { numberOfProviders: 2 }, "provider_count", 2],
      ["convert", { numberOfModules: 1 }, "module_count", 1],
      ["convert", { convertedLines: 42 }, "converted_lines", 42],
      ["convert", { convertedLines: "42" }, "converted_lines", undefined],
      ["convert", { convertedLines: NaN }, "converted_lines", undefined],
    ])(
      "%s: %j forwards %s as %j",
      async (command, payload, attribute, expected) => {
        await sendTelemetry(command, payload);
        expect(await Sentry.flush(2000)).toBe(true);

        const completed = parseMetricItems(envelopeBodies).find(
          (i) => i.name === "cli.command.completed",
        )!;
        if (expected === undefined) {
          expect(completed.attributes).not.toHaveProperty(attribute);
        } else {
          expect(attributeValues(completed)[attribute]).toBe(expected);
        }
      },
    );

    it.each([
      [">= 1.9.0", ">=1.9.0"],
      ["~1.8", ">=1.8.0 <1.9.0-0"],
      ["1.2.3 - 2.0.0", ">=1.2.3 <=2.0.0"],
      [">=1.0.0 <2.0.0 || 1.2.3", ">=1.0.0 <2.0.0||1.2.3"],
      ["latest /Users/x", "invalid"],
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
          { version: "dev-/Users/x" },
        ],
      });

      const items = await deliveredItems();
      // build metadata is stripped like binary_version; a version without a
      // MAJOR.MINOR.PATCH prefix yields no attribute at all
      expect(
        metrics(items, "cli.stack").map((stack) => [
          stack.backend,
          stack.library_version,
        ]),
      ).toEqual([
        ["other", "0.21.0"],
        ["other", undefined],
        ["unknown", undefined],
      ]);
      expect(
        metrics(items, "cli.stack.override").map((o) => [
          o.resource_type,
          o.override_count,
        ]),
      ).toEqual([
        ["aws_s3_bucket", 1],
        ["module.terraform-aws-modules/vpc/aws", 1],
        ["other", 3],
        ["terraform_remote_state", 1],
      ]);
      expect(envelopeBodies.join("\n")).not.toContain("/Users/x");
    });
  });

  describe("provider binding classification", () => {
    beforeEach(() => {
      initSentryWithCapturingTransport();
    });

    async function bindingOf(source: string) {
      await sendTelemetry("synth", {
        stackMetadata: [{}],
        requiredProviders: [{ provider: { source } }],
      });
      return metrics(await deliveredItems(), "cli.stack.provider").map(
        (provider) => provider.binding,
      );
    }

    it.each([
      ["aws", "generated"],
      ["Hashicorp/Random", "generated"],
      ["kreuzwerker/docker", "generated"],
      ["hashicorp/google", "generated"],
      ["azurerm", "generated"],
      ["hashicorp/null", "prebuilt"],
      ["tfe.corp.example.com/acme-org/vault", "generated"],
      // another private source is not the generated one, even though both
      // reach the metric as "private-registry"
      ["tfe.corp.example.com/other-org/vault", "prebuilt"],
    ])(
      "sends the required provider %s as %s for the project's terraformProviders",
      async (source, expected) => {
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

        expect(await bindingOf(source)).toEqual([expected]);
      },
    );

    it("sends every provider as prebuilt when terraformProviders is not a list", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        terraformProviders: "aws",
      });

      expect(await bindingOf("aws")).toEqual(["prebuilt"]);
    });
  });

  describe("source normalization", () => {
    beforeEach(() => {
      initSentryWithCapturingTransport();
    });

    it.each([
      ["aws", "hashicorp/aws"],
      ["aws@~>5.0", "hashicorp/aws"],
      ["Hashicorp/AWS@5.1.0", "hashicorp/aws"],
      ["registry.terraform.io/hashicorp/aws", "hashicorp/aws"],
      ["registry.opentofu.org/hashicorp/aws", "hashicorp/aws"],
      ["tfe.leak-host.example/leak-org/aws", "private-registry"],
      ["localhost:8080/leak-org/aws", "private-registry"],
      ["./leak-provider", "other"],
      ["../leak/provider", "other"],
      ["/abs/leak/provider", "other"],
      ["leak-a/b/c", "other"],
      ["", "other"],
      ["registry.terraform.io/leak-namespace", "other"],
      [`${"n".repeat(65)}/aws`, "other"],
      [`${"n".repeat(64)}/aws`, `${"n".repeat(64)}/aws`],
      [`${"n".repeat(64)}/${"t".repeat(64)}`, "other"],
    ])("sends the provider source %s as %s", async (source, expected) => {
      await sendTelemetry("get", { targets: [{ type: "provider", source }] });

      expect(
        metrics(await deliveredItems(), "cli.get.provider").map(
          (item) => item.provider,
        ),
      ).toEqual([expected]);
      expect(envelopeBodies.join("\n")).not.toContain("leak");
    });

    it.each([
      ["terraform-aws-modules/vpc/aws", "terraform-aws-modules/vpc/aws"],
      ["Terraform-AWS-Modules/VPC/aws", "terraform-aws-modules/vpc/aws"],
      // one row per fallthrough: everything the grammar rejects is "other"
      ["Terraform-AWS-Modules/leak-vpc/aws?ref=v5.0.0", "other"],
      [`${"n".repeat(64)}/vpc/aws`, `${"n".repeat(64)}/vpc/aws`],
      [`${"n".repeat(65)}/vpc/aws`, "other"],
      ["app.terraform.io/leak-org/vpc/aws", "private-registry"],
      ["./modules/leak-vpc", "local"],
      ["../shared/leak-vpc", "local"],
      ["/abs/path/leak-vpc", "local"],
      ["git@github.com:leak-org/repo.git", "git"],
      ["github.com/leak-org/repo", "git"],
      ["bitbucket.org/leak-org/repo", "git"],
      ["https://leak-host.example/vpc.zip", "git"],
      ["s3-eu-west-1.amazonaws.com/leak-bucket/vpc.zip", "git"],
      ["www.googleapis.com/storage/v1/leak-bucket/vpc", "git"],
      // forced getters without a URL scheme behind them
      ["git::leak-host.example/leak-org/repo.git", "git"],
      ["hg::leak-host.example/leak-repo", "git"],
      ["s3::leak-bucket/vpc.zip", "git"],
      ["gcs::leak-bucket/vpc", "git"],
    ])("sends the module source %s as %s", async (source, expected) => {
      await sendTelemetry("get", { targets: [{ type: "module", source }] });

      expect(
        metrics(await deliveredItems(), "cli.get.module").map(
          (item) => item.module,
        ),
      ).toEqual([expected]);
      expect(envelopeBodies.join("\n")).not.toContain("leak");
    });

    it.each([
      [">= 1.2, < 2.0", ">= 1.2, < 2.0"],
      ["~> 5.0", "~> 5.0"],
      ["= 1.0", "= 1.0"],
      ["!= 1.2.3", "!= 1.2.3"],
      ["1.2.3", "1.2.3"],
      ["  >= 1.0 ,  < 2.0  ", ">= 1.0, < 2.0"],
      ["~>5.0,!=5.1.0", "~> 5.0, != 5.1.0"],
      [">= 1.0.0-leak-prerelease.corp", "invalid"],
      ["1.2.3+leak-build.host", "invalid"],
      ["~> 5.0 # /Users/leak", "invalid"],
      [">= 1.2 || < 2.0", "invalid"],
      // valid by the grammar, over the length a constraint may have
      [Array(12).fill("!= 1.0.0").join(", "), "invalid"],
    ])("sends the provider constraint %p as %p", async (version, expected) => {
      await sendTelemetry("synth", {
        stackMetadata: [{}],
        requiredProviders: [{ aws: { source: "aws", version } }],
      });

      expect(
        metrics(await deliveredItems(), "cli.stack.provider").map(
          (provider) => provider.version_constraint,
        ),
      ).toEqual([expected]);
      expect(envelopeBodies.join("\n")).not.toContain("leak");
    });
  });

  describe("package manager", () => {
    beforeEach(() => {
      initSentryWithCapturingTransport();
    });

    afterEach(() => {
      jest.dontMock("./node-package-manager");
    });

    // a copy of the module whose node detector is replaced
    function telemetryWithNodeDetector(detect: () => string) {
      let copy!: typeof import("./telemetry");
      jest.isolateModules(() => {
        jest.doMock("./node-package-manager", () => ({
          detectNodePackageManager: detect,
        }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        copy = require("./telemetry");
      });
      return copy;
    }

    // one successful and one failed end, so every command metric is covered
    async function runMetrics(
      telemetry: Pick<
        typeof import("./telemetry"),
        "startCommandTelemetry" | "sendTelemetry"
      > = { startCommandTelemetry, sendTelemetry },
    ): Promise<MetricItem[]> {
      await telemetry.startCommandTelemetry("synth");
      await telemetry.sendTelemetry("synth", {});
      await telemetry.sendTelemetry("synth", { error: true });
      expect(await Sentry.flush(2000)).toBe(true);

      const items = parseMetricItems(envelopeBodies);
      expect(items.map((i) => i.name)).toEqual([
        "cli.command.invoked",
        "cli.command.completed",
        "cli.command.error",
      ]);
      return items;
    }

    it.each([
      ["no lockfile", "npm", {}],
      ["a pnpm lockfile", "pnpm", { "pnpm-lock.yaml": "" }],
      ["a yarn lockfile", "yarn", { "yarn.lock": "" }],
      ["a .yarnrc.yml", "yarn-berry", { ".yarnrc.yml": "" }],
      [
        "a declared npm",
        "npm",
        { "package.json": '{"packageManager":"npm@10.8.2"}' },
      ],
      [
        "a declared pnpm with a hash",
        "pnpm",
        { "package.json": '{"packageManager":"pnpm@10.26.0+sha512.LEAK"}' },
      ],
      [
        "a declared yarn 1",
        "yarn",
        { "package.json": '{"packageManager":"yarn@1.22.22"}' },
      ],
      [
        "a declared yarn 4",
        "yarn-berry",
        { "package.json": '{"packageManager":"yarn@4.1.0"}' },
      ],
      [
        "an unknown declared manager",
        "npm",
        { "package.json": '{"packageManager":"bun@1.1.0-LEAK"}' },
      ],
    ])(
      "reports a typescript project with %s as %p on every command metric",
      async (_name, expected, files) => {
        fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
          language: "typescript",
        });
        for (const [name, content] of Object.entries(files)) {
          fs.writeFileSync(path.join(workdir, name), content as string);
        }

        for (const item of await runMetrics()) {
          expect(attributeValues(item).package_manager).toBe(expected);
        }
        const bytes = envelopeBodies.join("\n");
        expect(bytes).not.toContain("LEAK");
        expect(bytes).not.toContain("10.26.0");
      },
    );

    it.each([
      ["python", { app: "pipenv run python main.py" }, {}, "pipenv"],
      ["python", { app: "python3 main.py" }, {}, "pip"],
      ["java", {}, { "build.gradle": "" }, "gradle"],
      ["java", {}, { "pom.xml": "" }, "maven"],
      ["csharp", {}, {}, "nuget"],
      ["go", {}, {}, "go"],
    ])(
      "reports a %s project with %j and files %j as %p",
      async (language, config, files, expected) => {
        fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
          language,
          ...config,
        });
        for (const [name, content] of Object.entries(files)) {
          fs.writeFileSync(path.join(workdir, name), content as string);
        }

        for (const item of await runMetrics()) {
          expect(attributeValues(item).package_manager).toBe(expected);
        }
      },
    );

    it.each([
      ["no cdktf.json", undefined],
      ["an unsupported language", { language: "rust" }],
      ["no language", { app: "pipenv run python main.py" }],
      ["a python project without an app command", { language: "python" }],
    ])("omits the attribute with %s", async (_name, cdktfJson) => {
      if (cdktfJson) {
        fs.writeJsonSync(path.join(workdir, "cdktf.json"), cdktfJson);
      }
      // lockfiles alone never identify a project
      fs.writeFileSync(path.join(workdir, "pnpm-lock.yaml"), "");
      fs.writeFileSync(path.join(workdir, "build.gradle"), "");

      for (const item of await runMetrics()) {
        expect(item.attributes).not.toHaveProperty("package_manager");
      }
    });

    it("keeps the value detected at start when the cwd changes before the end", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
      });
      fs.writeFileSync(path.join(workdir, "pnpm-lock.yaml"), "");
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-else-"));

      try {
        await startCommandTelemetry("convert");
        process.chdir(elsewhere);
        await sendTelemetry("convert", {});
        await sendTelemetry("convert", { error: true });
        expect(await Sentry.flush(2000)).toBe(true);
      } finally {
        process.chdir(workdir);
        fs.removeSync(elsewhere);
      }

      const items = parseMetricItems(envelopeBodies);
      expect(items).toHaveLength(3);
      for (const item of items) {
        expect(attributeValues(item).package_manager).toBe("pnpm");
      }
    });

    it("forgets the value with the run", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), { language: "go" });

      await startCommandTelemetry("synth");
      resetCommandTelemetry();
      await sendTelemetry("synth", {});
      expect(await Sentry.flush(2000)).toBe(true);

      const completed = parseMetricItems(envelopeBodies).find(
        (i) => i.name === "cli.command.completed",
      )!;
      expect(completed.attributes).not.toHaveProperty("package_manager");
    });

    it("omits a detector value outside the closed set", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
      });
      const telemetry = telemetryWithNodeDetector(() => "bun@1.1.0 /Users/x");

      for (const item of await runMetrics(telemetry)) {
        expect(item.attributes).not.toHaveProperty("package_manager");
      }
      expect(envelopeBodies.join("\n")).not.toContain("bun");
    });

    it("omits the attribute when detection throws", async () => {
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "typescript",
      });
      const telemetry = telemetryWithNodeDetector(() => {
        throw new Error("EACCES");
      });

      for (const item of await runMetrics(telemetry)) {
        expect(item.attributes).not.toHaveProperty("package_manager");
      }
    });

    it("normalizes to members of the closed set only", () => {
      for (const name of PACKAGE_MANAGERS) {
        expect(normalizePackageManager(name)).toBe(name);
      }
      for (const value of [
        "bun",
        "NPM",
        "pnpm@10.26.0+sha512.abc",
        "/usr/local/bin/npm",
        "",
        1,
        null,
        undefined,
        ["npm"],
      ]) {
        expect(normalizePackageManager(value)).toBeUndefined();
      }
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

    it("observes the captured decision and targets, the started command and its language from the other copy", async () => {
      // the project opts out; only the decision captured by the first copy
      // lets the second one emit
      fs.writeJsonSync(path.join(workdir, "cdktf.json"), {
        language: "go",
        sendUsageTelemetry: false,
      });
      setUsageTelemetryEnabled(true);
      setProjectTargetAttributes({ target_opentofu: ">=1.7.0" });
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
      expect(attributeValues(items[1])).toMatchObject({
        language: "go",
        package_manager: "go",
        target_opentofu: ">=1.7.0",
      });
      expect(items[1].attributes).not.toHaveProperty("target_terraform");
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

  describe("binary attributes", () => {
    async function invokedAttributes(versionOutput: string) {
      seedTerraformCliProbeForTests(Promise.resolve(versionOutput));
      initSentryWithCapturingTransport();
      await startCommandTelemetry("synth");
      expect(await Sentry.flush(2000)).toBe(true);
      return attributeValues(parseMetricItems(envelopeBodies)[0]);
    }

    it.each([
      ["Terraform v1.10.0-alpha20250101", "terraform", "1.10.0"],
      [
        "OpenTofu v1.2.3-LEAK-HOST.corp.example.com+LEAK-BUILD/Users/x",
        "opentofu",
        "1.2.3",
      ],
    ])(
      "reduces the probed version of %p to its release",
      async (versionOutput, binary, release) => {
        expect(await invokedAttributes(versionOutput)).toMatchObject({
          binary,
          binary_version: release,
        });
        expect(envelopeBodies.join("\n")).not.toContain("LEAK");
      },
    );

    it("sends no version for an unrecognised product: a wrapper's output has no product version line", async () => {
      const attributes = await invokedAttributes(
        "connected to 10.0.0.1 as LEAK-USER (wrapper 3.4.5)\nTerraform v1.9.0\n",
      );
      expect(attributes.binary).toBe("unknown");
      expect(attributes).not.toHaveProperty("binary_version");
      expect(envelopeBodies.join("\n")).not.toContain("LEAK-USER");
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

    it.each([
      [{}],
      [{ targetVersions: "nope" }],
      [{ targetVersions: [] }],
      [undefined],
    ])("falls back to the defaults for a cdktf.json of %j", (config) => {
      if (config) {
        fs.writeJsonSync(path.join(workdir, "cdktf.json"), config);
      }
      expect(getProjectTargetAttributes(workdir)).toEqual({
        targets_declared: false,
        validate_installed_binary: false,
        ...DEFAULT_TARGET_VERSIONS_AS_ATTRIBUTES,
      });
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
