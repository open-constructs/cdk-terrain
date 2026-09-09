// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as Sentry from "@sentry/node";
import * as path from "path";
import * as fs from "fs-extra";
import ciInfo from "ci-info";
import { logger } from "./logging";
import { DEFAULT_TARGET_VERSIONS, isLocalModule } from "./config";
import { isRegistryModule } from "./terraform-module";
import { terraformCli, TerraformCliProbe } from "./terraform";

type AttributeValue = string | number | boolean;
type Attributes = Record<string, AttributeValue>;

/**
 * Raw `cdktf.json` read that never throws: telemetry must work outside a
 * project and must not depend on cli-core's typed config (commons cannot
 * import cli-core).
 */
function readRawCdktfJson(projectPath: string): Record<string, any> {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(projectPath, "cdktf.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

/**
 * Reads the raw `sendUsageTelemetry` flag from `cdktf.json`. Returns
 * `undefined` when the flag is unset or no readable `cdktf.json` exists;
 * `isUsageTelemetryEnabled` derives the effective state.
 */
export function getUsageTelemetryConsent(
  projectPath = process.cwd(),
): boolean | undefined {
  const cdktfJson = readRawCdktfJson(projectPath);
  if (!("sendUsageTelemetry" in cdktfJson)) {
    return undefined;
  }
  // init templates render booleans as the strings "true"/"false"
  return typeof cdktfJson.sendUsageTelemetry === "boolean"
    ? cdktfJson.sendUsageTelemetry
    : cdktfJson.sendUsageTelemetry === "true";
}

// Captured by initializErrorReporting (cli-core) while still in the user's
// cwd: `convert` chdirs into a throwaway project before emitting, so
// re-reading cdktf.json at emission time would consult the wrong project.
let usageTelemetryEnabledState: boolean | undefined;

export function setUsageTelemetryEnabled(enabled: boolean | undefined): void {
  usageTelemetryEnabledState = enabled;
}

/**
 * Effective usage-telemetry gate: `CHECKPOINT_DISABLE` > the decision captured
 * at command start > `sendUsageTelemetry` in `cdktf.json` > enabled by
 * default. Independent of crash reporting (`sendCrashReports`).
 */
export function isUsageTelemetryEnabled(projectPath = process.cwd()): boolean {
  if (process.env.CHECKPOINT_DISABLE) {
    return false;
  }
  if (usageTelemetryEnabledState !== undefined) {
    return usageTelemetryEnabledState;
  }
  return getUsageTelemetryConsent(projectPath) !== false;
}

/**
 * The project's declared Terraform/OpenTofu targets as metric attributes.
 * Falls back to the CLI defaults so every metric carries the ranges the
 * command actually validated against.
 */
export function getProjectTargetAttributes(
  projectPath = process.cwd(),
): Attributes {
  const cdktfJson = readRawCdktfJson(projectPath);
  const declared =
    cdktfJson.targetVersions &&
    typeof cdktfJson.targetVersions === "object" &&
    !Array.isArray(cdktfJson.targetVersions)
      ? cdktfJson.targetVersions
      : undefined;
  const targets: Record<string, unknown> = declared ?? DEFAULT_TARGET_VERSIONS;
  const attributes: Attributes = {
    targets_declared: declared !== undefined,
    validate_installed_binary: cdktfJson.validateInstalledBinary === true,
  };
  if (typeof targets.terraform === "string") {
    attributes.target_terraform = targets.terraform;
  }
  if (typeof targets.opentofu === "string") {
    attributes.target_opentofu = targets.opentofu;
  }
  return attributes;
}

// Captured alongside the consent decision, for the same reason: the project
// the user ran the command in, not the one the command may chdir into.
let projectTargetAttributes: Attributes | undefined;

export function setProjectTargetAttributes(
  attributes: Attributes | undefined,
): void {
  projectTargetAttributes = attributes;
}

/**
 * Binary attributes from the version probe, bounded so a hung binary never
 * delays the command; a timed-out probe reports `binary: "unknown"`.
 */
export async function getBinaryAttributes(
  probe: Promise<TerraformCliProbe> = terraformCli,
  timeoutMs = 1500,
): Promise<Attributes> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<TerraformCliProbe>((resolve) => {
    timer = setTimeout(() => resolve({ name: "unknown" }), timeoutMs);
  });
  try {
    const cli = await Promise.race([probe, timeout]);
    const attributes: Attributes = { binary: cli.name };
    if (cli.version) {
      attributes.binary_version = cli.version;
    }
    return attributes;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Counts an error built by the `Errors` factories as `cli.error` by type and
 * command, never message or context (both can carry paths and user input).
 * `cli.command.error` counts failed runs; a handled Usage error counts here.
 */
export function sendErrorTelemetry(type: string, command: string): void {
  try {
    if (!isUsageTelemetryEnabled()) {
      return;
    }
    Sentry.metrics.count("cli.error", 1, { attributes: { type, command } });
  } catch (err) {
    logger.debug(`Could not send error telemetry: ${err}`);
  }
}

/**
 * Bounded flush of buffered telemetry. Call before any explicit
 * `process.exit()` on a path that may have emitted metrics: Sentry buffers
 * asynchronously and a hard exit drops the buffer.
 */
export async function flushTelemetry(timeoutMs = 4000): Promise<void> {
  try {
    await Sentry.flush(timeoutMs);
  } catch (err) {
    logger.debug(`Could not flush telemetry: ${err}`);
  }
}

const PUBLIC_PROVIDER_REGISTRIES = [
  "registry.terraform.io",
  "registry.opentofu.org",
];
const PROVIDER_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;
const PROVIDER_HOST = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?$/;

/**
 * Provider identity for metrics: only public-registry `namespace/type` is sent
 * (`aws`, `hashicorp/aws@~>5`, `registry.terraform.io/hashicorp/aws` are one);
 * other hosts become "private-registry", paths and malformed input "other".
 */
export function normalizeProviderSource(source: string): string {
  const segments = source.trim().toLowerCase().split("@")[0].split("/");
  if (segments.length === 3) {
    const host = segments.shift()!;
    if (!PUBLIC_PROVIDER_REGISTRIES.includes(host)) {
      return PROVIDER_HOST.test(host) ? "private-registry" : "other";
    }
  }
  if (segments.length === 1) {
    segments.unshift("hashicorp");
  }
  return segments.length === 2 &&
    segments.every((s) => PROVIDER_SEGMENT.test(s))
    ? segments.join("/")
    : "other";
}

/**
 * Normalized sources of the providers a project generates bindings for
 * (`terraformProviders` in `cdktf.json`, as `"aws@~>5.0"` strings or
 * `{ name, source }` objects); anything else in a stack is prebuilt.
 */
export function getGeneratedProviderSources(
  projectPath = process.cwd(),
): string[] {
  const entries = readRawCdktfJson(projectPath).terraformProviders;
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.flatMap((entry) => {
    if (typeof entry === "string") {
      return [normalizeProviderSource(entry)];
    }
    const source = entry?.source ?? entry?.name;
    return typeof source === "string" ? [normalizeProviderSource(source)] : [];
  });
}

export function classifyProviderBinding(
  source: string,
  generatedSources: string[],
): "generated" | "prebuilt" {
  return generatedSources.includes(normalizeProviderSource(source))
    ? "generated"
    : "prebuilt";
}

/**
 * Module identity for metrics. Only public registry sources are sent as-is;
 * anything else could carry a path, hostname or organization and is reduced
 * to its kind.
 */
export function classifyModuleSource(source: string): string {
  const trimmed = source.trim();
  if (isLocalModule(trimmed) || path.isAbsolute(trimmed)) {
    return "local";
  }
  if (/^git(::|@)|:\/\/|^github\.com\/|^bitbucket\.org\//i.test(trimmed)) {
    return "git";
  }
  if (!isRegistryModule(trimmed)) {
    return "other";
  }
  return trimmed.split("/").length === 4
    ? "private-registry"
    : trimmed.toLowerCase();
}

// Scalar payload fields forwarded as attributes, per command. Anything not
// listed here (and every array/object) stays out of the metric.
const SCALAR_ATTRIBUTES: Record<string, Record<string, string>> = {
  synth: { synthOrigin: "synth_origin" },
  init: { template: "template", isRemote: "is_remote" },
  convert: {
    numberOfModules: "module_count",
    numberOfProviders: "provider_count",
    convertedLines: "converted_lines",
  },
  watch: { event: "event" },
};

function isScalar(value: unknown): value is AttributeValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

// Number of entries per key of a metadata group such as
// `overrides: { aws_s3_bucket: ["tags", "region"] }`.
function groupSizes(group: unknown): Record<string, number> {
  const sizes: Record<string, number> = {};
  if (group && typeof group === "object" && !Array.isArray(group)) {
    for (const [key, entries] of Object.entries(group)) {
      sizes[key] = Array.isArray(entries) ? entries.length : 0;
    }
  }
  return sizes;
}

function sum(sizes: Record<string, number>): number {
  return Object.values(sizes).reduce((total, size) => total + size, 0);
}

// Override keys are provider schema names, except module overrides which
// carry the module source and are reduced to its kind.
function overrideResourceType(key: string): string {
  return key.startsWith("module.")
    ? `module.${classifyModuleSource(key.slice("module.".length))}`
    : key;
}

/**
 * Per-stack metrics for synth/diff/deploy/destroy from the stack metadata
 * block and `required_providers`: backend and library version, override /
 * import / moved counts and the providers used, never names or ids.
 */
function sendStackTelemetry(
  stackMetadata: unknown[],
  requiredProviders: unknown[],
  attributes: Attributes,
): void {
  const generatedSources = getGeneratedProviderSources();
  stackMetadata.forEach((entry, index) => {
    const metadata: Record<string, any> =
      entry && typeof entry === "object" ? entry : {};
    const overrides = groupSizes(metadata.overrides);
    const stackAttributes: Attributes = {
      ...attributes,
      backend:
        typeof metadata.backend === "string" ? metadata.backend : "unknown",
      cloud: typeof metadata.cloud === "string",
      override_count: sum(overrides),
      import_count: sum(groupSizes(metadata.imports)),
      moved_count: sum(groupSizes(metadata.moved)),
    };
    if (typeof metadata.version === "string") {
      stackAttributes.library_version = metadata.version;
    }
    Sentry.metrics.count("cli.stack", 1, { attributes: stackAttributes });

    for (const [key, count] of Object.entries(overrides)) {
      Sentry.metrics.count("cli.stack.override", 1, {
        attributes: {
          ...attributes,
          resource_type: overrideResourceType(key),
          override_count: count,
        },
      });
    }

    const providers = requiredProviders[index];
    if (!providers || typeof providers !== "object") {
      return;
    }
    for (const [type, constraint] of Object.entries(
      providers as Record<string, any>,
    )) {
      const source =
        typeof constraint?.source === "string" ? constraint.source : type;
      const providerAttributes: Attributes = {
        ...attributes,
        provider: normalizeProviderSource(source),
        binding: classifyProviderBinding(source, generatedSources),
      };
      if (typeof constraint?.version === "string") {
        providerAttributes.version_constraint = constraint.version.slice(0, 64);
      }
      Sentry.metrics.count("cli.stack.provider", 1, {
        attributes: providerAttributes,
      });
    }
  });
}

interface GetTarget {
  type: "provider" | "module";
  source: string;
}

// `get` payload: one entry per generated binding, counted per provider and
// module; only the totals land on the command metric.
function sendGetTelemetry(targets: GetTarget[], attributes: Attributes): void {
  const providers = targets.filter((t) => t.type === "provider");
  const modules = targets.filter((t) => t.type === "module");
  attributes.provider_count = providers.length;
  attributes.module_count = modules.length;
  for (const target of providers) {
    Sentry.metrics.count("cli.get.provider", 1, {
      attributes: {
        ...attributes,
        provider: normalizeProviderSource(target.source),
      },
    });
  }
  for (const target of modules) {
    Sentry.metrics.count("cli.get.module", 1, {
      attributes: {
        ...attributes,
        module: classifyModuleSource(target.source),
      },
    });
  }
}

// `init` payload: the providers the new project was created with.
function sendInitTelemetry(providers: string[], attributes: Attributes): void {
  attributes.provider_count = providers.length;
  for (const provider of providers) {
    Sentry.metrics.count("cli.init.provider", 1, {
      attributes: {
        ...attributes,
        provider: normalizeProviderSource(provider),
      },
    });
  }
}

/**
 * Emits a command's usage telemetry as Sentry metrics; payload fields reach
 * the attributes only through the allow-lists above. A silent no-op when
 * usage telemetry is disabled or Sentry is not initialized.
 */
export async function sendTelemetry(
  command: string,
  payload: Record<string, any>,
): Promise<void> {
  try {
    if (!isUsageTelemetryEnabled()) {
      return;
    }

    const ci: string | false = ciInfo.isCI ? ciInfo.name || "unknown" : false;
    const attributes: Attributes = {
      command,
      ci: ci === false ? false : ci,
      os: process.platform,
      arch: process.arch,
      ...(projectTargetAttributes ?? getProjectTargetAttributes()),
      ...(await getBinaryAttributes()),
    };
    if (typeof payload.language === "string") {
      attributes.language = payload.language;
    }
    for (const [key, attribute] of Object.entries(
      SCALAR_ATTRIBUTES[command] ?? {},
    )) {
      if (isScalar(payload[key])) {
        attributes[attribute] = payload[key];
      }
    }

    if (payload.error) {
      Sentry.metrics.count("cli.command.error", 1, { attributes });
      return;
    }

    if (command === "get" && Array.isArray(payload.targets)) {
      sendGetTelemetry(payload.targets, attributes);
    }
    if (command === "init" && Array.isArray(payload.addedProviders)) {
      sendInitTelemetry(payload.addedProviders, attributes);
    }
    if (Array.isArray(payload.stackMetadata)) {
      sendStackTelemetry(
        payload.stackMetadata,
        Array.isArray(payload.requiredProviders)
          ? payload.requiredProviders
          : [],
        attributes,
      );
    }
    if (
      typeof payload.failedStackCount === "number" &&
      payload.failedStackCount > 0
    ) {
      Sentry.metrics.count("cli.stack.failed", payload.failedStackCount, {
        attributes,
      });
    }

    Sentry.metrics.count("cli.command.invoked", 1, { attributes });
    if (typeof payload.totalTime === "number") {
      Sentry.metrics.distribution("cli.synth.duration", payload.totalTime, {
        unit: "millisecond",
        attributes,
      });
    }
  } catch (err) {
    logger.debug(`Could not send telemetry data: ${err}`);
  }
}
