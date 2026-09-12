// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as Sentry from "@sentry/node";
import * as path from "path";
import * as fs from "fs-extra";
import * as semver from "semver";
import ciInfo from "ci-info";
import { logger } from "./logging";
import { DEFAULT_TARGET_VERSIONS, LANGUAGES, isLocalModule } from "./config";
import { processState } from "./process-state";
import { isRegistryModule } from "./terraform-module";
import { terraformCli, TerraformCliProbe } from "./terraform";

type AttributeValue = string | number | boolean;
type Attributes = Record<string, AttributeValue>;

/** Error class of a failed command run: a typed `Errors` value or "unexpected". */
export const COMMAND_ERROR_TYPES = [
  "Usage",
  "External",
  "Internal",
  "unexpected",
] as const;
export type CommandErrorType = (typeof COMMAND_ERROR_TYPES)[number];

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
  // init templates render booleans as the strings "true"/"false"; a
  // boolean-only check would opt every freshly init'ed project out
  return typeof cdktfJson.sendUsageTelemetry === "boolean"
    ? cdktfJson.sendUsageTelemetry
    : cdktfJson.sendUsageTelemetry === "true";
}

type CommandTelemetryState = {
  // Captured by initializErrorReporting (cli-core) while still in the user's
  // cwd: `convert` chdirs into a throwaway project before emitting, so
  // re-reading cdktf.json at emission time would consult the wrong project.
  usageTelemetryEnabled?: boolean;
  // The command this run was started as; set once by startCommandTelemetry so
  // a second reporting init (init runs get, provider add runs get) and the
  // operations a command drives (a deploy's synth) never count as runs.
  startedCommand?: string;
  // The raw `language` of the project the run started in, so every metric of
  // the run (the error metric has no payload) carries the one `invoked` did.
  language?: unknown;
  // Captured alongside the consent decision, for the same reason: the project
  // the user ran the command in, not the one the command may chdir into.
  projectTargetAttributes?: Attributes;
};

// Shared by both bundle copies: the handlers' copy captures the decision and
// starts the run, the entrypoint's copy counts the failure.
const state = processState<CommandTelemetryState>(
  "cdktn.commandTelemetry",
  () => ({}),
);

// Free-text payload fields are validated before they become attributes so a
// misconfigured or hand-edited value never carries arbitrary text.
const CONSTRAINT_PART = /^(=|!=|>=|<=|>|<|~>)?\s*(\d+(?:\.\d+){0,2})$/;
const RELEASE_VERSION = /^\d+\.\d+\.\d+/;

// Terraform's built-in backend kinds; anything else (a typo, a hand-edited
// value) is reduced to "other".
const BACKEND_KINDS = [
  "local",
  "remote",
  "cloud",
  "s3",
  "gcs",
  "azurerm",
  "http",
  "consul",
  "kubernetes",
  "pg",
  "oss",
  "cos",
  "etcdv3",
  "artifactory",
  "swift",
  "manta",
];

/** Backend kind for metrics: a built-in kind as-is, anything else "other". */
export function normalizeBackendKind(backend: unknown): string {
  if (typeof backend !== "string") {
    return "unknown";
  }
  return BACKEND_KINDS.includes(backend) ? backend : "other";
}

// Terraform resource type grammar; the stack-level override keys (stack,
// backend, output, local, terraform_remote_state) are identifiers too.
const RESOURCE_TYPE = /^[a-z][a-z0-9_]*$/;

// MAJOR.MINOR.PATCH only: prerelease and build identifiers are free text
// (a wrapper's version line or a locally built library can carry anything).
function releaseVersion(value: string | undefined): string | undefined {
  return RELEASE_VERSION.exec(value ?? "")?.[0];
}

// Normalized so spacing variants collapse into one value; a prerelease or
// build identifier is free text and rejects the range (hyphen ranges are
// written " - ", so a hyphen right after a digit is always a prerelease).
function semverRangeOrInvalid(value: string): string {
  const range = value.length <= 64 ? semver.validRange(value) : null;
  return range && !/\d[-+]/.test(value) ? range : "invalid";
}

/**
 * Terraform provider constraint: comma-separated operators over versions,
 * re-joined as "~> 5.0, != 5.1.0" so spacing variants collapse into one
 * value. Constraints are user-authored free text in cdktf.json, so a
 * prerelease identifier or an over-long value rejects the whole constraint.
 */
export function normalizeProviderConstraint(value: string): string {
  if (value.length > 64) {
    return "invalid";
  }
  const parts: string[] = [];
  for (const part of value.split(",")) {
    const match = CONSTRAINT_PART.exec(part.trim());
    if (!match) {
      return "invalid";
    }
    const [, operator, version] = match;
    parts.push(operator ? `${operator} ${version}` : version);
  }
  return parts.join(", ");
}

export function setUsageTelemetryEnabled(enabled: boolean | undefined): void {
  state.usageTelemetryEnabled = enabled;
}

/**
 * Whether a command already captured its consent decision. `init` initializes
 * reporting for the project it just created and must not overwrite the
 * decision of a command (`convert`) that drives it inside a throwaway project.
 */
export function hasCapturedUsageTelemetryDecision(): boolean {
  return state.usageTelemetryEnabled !== undefined;
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
  if (state.usageTelemetryEnabled !== undefined) {
    return state.usageTelemetryEnabled;
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
    attributes.target_terraform = semverRangeOrInvalid(targets.terraform);
  }
  if (typeof targets.opentofu === "string") {
    attributes.target_opentofu = semverRangeOrInvalid(targets.opentofu);
  }
  return attributes;
}

export function setProjectTargetAttributes(
  attributes: Attributes | undefined,
): void {
  state.projectTargetAttributes = attributes;
}

/**
 * Binary attributes from the version probe, bounded so a hung binary never
 * delays the command; a timed-out probe reports `binary: "unknown"`.
 */
export async function getBinaryAttributes(
  probe: Promise<TerraformCliProbe> = terraformCli(),
  timeoutMs = 1500,
): Promise<Attributes> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<TerraformCliProbe>((resolve) => {
    timer = setTimeout(() => resolve({ name: "unknown" }), timeoutMs);
  });
  try {
    const cli = await Promise.race([probe, timeout]);
    const attributes: Attributes = { binary: cli.name };
    // an unrecognised product's version is the first version-like token of
    // its output, which can be anything (a wrapper's "connected to 10.0.0.1")
    const release =
      cli.name === "terraform" || cli.name === "opentofu"
        ? releaseVersion(cli.version)
        : undefined;
    if (release) {
      attributes.binary_version = release;
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

// Registry identities are bounded so an over-long hand-written source cannot
// carry free text through the segment grammar.
function withinIdentityLimits(segments: string[]): boolean {
  return (
    segments.every((segment) => segment.length <= 64) &&
    segments.join("/").length <= 128
  );
}

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
    segments.every((s) => PROVIDER_SEGMENT.test(s)) &&
    withinIdentityLimits(segments)
    ? segments.join("/")
    : "other";
}

// Comparison key for generated-vs-prebuilt, never sent: public sources
// normalize, anything else stays raw so two unrelated private sources (both
// "private-registry" on the metric) never match each other.
function providerIdentity(source: string): string {
  const normalized = normalizeProviderSource(source);
  return normalized === "private-registry" || normalized === "other"
    ? source.trim().toLowerCase().split("@")[0]
    : normalized;
}

/**
 * Identities of the providers a project generates bindings for
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
      return [providerIdentity(entry)];
    }
    const source = entry?.source ?? entry?.name;
    return typeof source === "string" ? [providerIdentity(source)] : [];
  });
}

export function classifyProviderBinding(
  source: string,
  generatedSources: string[],
): "generated" | "prebuilt" {
  return generatedSources.includes(providerIdentity(source))
    ? "generated"
    : "prebuilt";
}

// Public registry addresses are `namespace/name/provider` with plain segments;
// a dot, colon or `~` in a segment marks a hostname, bucket or home path that
// go-getter would resolve instead.
const REGISTRY_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;

// Forced getters, URLs and well-known object-store or forge hosts.
const REMOTE_SOURCE =
  /^(?:git|hg|s3|gcs)::|^git@|:\/\/|^github\.com\/|^bitbucket\.org\/|amazonaws\.com\/|googleapis\.com\//i;

/**
 * Module identity for metrics. Only public registry sources are sent as-is;
 * anything else could carry a path, hostname, bucket or organization and is
 * reduced to its kind.
 */
export function classifyModuleSource(source: string): string {
  const trimmed = source.trim();
  if (isLocalModule(trimmed) || path.isAbsolute(trimmed)) {
    return "local";
  }
  if (REMOTE_SOURCE.test(trimmed)) {
    return "git";
  }
  if (!isRegistryModule(trimmed)) {
    return "other";
  }
  const segments = trimmed.toLowerCase().split("/");
  if (segments.length === 4) {
    return "private-registry";
  }
  return segments.every((segment) => REGISTRY_SEGMENT.test(segment)) &&
    withinIdentityLimits(segments)
    ? segments.join("/")
    : "other";
}

// The synth origins the CLI passes through; see SynthOrigin in cli-core.
const SYNTH_ORIGINS = ["watch"];

type ScalarAttribute = {
  attribute: string;
  type: "string" | "number" | "boolean";
  /** Enumerated values; a value outside the set is dropped. */
  values?: string[];
};

// Scalar payload fields forwarded as attributes, per command, each with the
// type (and where enumerable, the values) it must have. Anything not listed
// here, of the wrong type or off the value set stays out of the metric.
const SCALAR_ATTRIBUTES: Record<string, Record<string, ScalarAttribute>> = {
  synth: {
    synthOrigin: {
      attribute: "synth_origin",
      type: "string",
      values: SYNTH_ORIGINS,
    },
  },
  init: {
    // reduced to a built-in template name or "remote" by templateTelemetryName
    template: { attribute: "template", type: "string" },
    isRemote: { attribute: "is_remote", type: "boolean" },
  },
  convert: {
    numberOfModules: { attribute: "module_count", type: "number" },
    numberOfProviders: { attribute: "provider_count", type: "number" },
    convertedLines: { attribute: "converted_lines", type: "number" },
  },
};

function scalarAttributeValue(
  value: unknown,
  spec: ScalarAttribute,
): AttributeValue | undefined {
  if (typeof value !== spec.type) {
    return undefined;
  }
  if (spec.type === "number" && !Number.isFinite(value)) {
    return undefined;
  }
  if (spec.values && !spec.values.includes(value as string)) {
    return undefined;
  }
  return value as AttributeValue;
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
  const resourceType = key.startsWith("module.")
    ? `module.${classifyModuleSource(key.slice("module.".length))}`
    : key;
  return resourceType.length <= 64 &&
    (RESOURCE_TYPE.test(resourceType) || resourceType.startsWith("module."))
    ? resourceType
    : "other";
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
    // a null or non-object entry is not a stack: counting one would inflate
    // the stack count with metadata the library never wrote
    if (!entry || typeof entry !== "object") {
      return;
    }
    const metadata = entry as Record<string, any>;
    const overrides = groupSizes(metadata.overrides);
    const stackAttributes: Attributes = {
      ...attributes,
      backend: normalizeBackendKind(metadata.backend),
      cloud: typeof metadata.cloud === "string",
      override_count: sum(overrides),
      import_count: sum(groupSizes(metadata.imports)),
      moved_count: sum(groupSizes(metadata.moved)),
    };
    const libraryVersion = releaseVersion(metadata.version);
    if (libraryVersion) {
      stackAttributes.library_version = libraryVersion;
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
        providerAttributes.version_constraint = normalizeProviderConstraint(
          constraint.version,
        );
      }
      Sentry.metrics.count("cli.stack.provider", 1, {
        attributes: providerAttributes,
      });
    }
  });
}

// Payload entries are validated one by one: a throw here would be swallowed
// by sendTelemetry's catch and skip the command metric for the whole run.
function sourceOf(entry: unknown): string | undefined {
  return typeof entry === "string" ? entry : undefined;
}

// `get` payload: one entry per generated binding, counted per provider and
// module; only the totals land on the command metric.
function sendGetTelemetry(targets: unknown[], attributes: Attributes): void {
  const byType = (type: string) =>
    targets.flatMap((target: any) => {
      const source = sourceOf(target?.source);
      return target?.type === type && source !== undefined ? [source] : [];
    });
  const providers = byType("provider");
  const modules = byType("module");
  attributes.provider_count = providers.length;
  attributes.module_count = modules.length;
  for (const source of providers) {
    Sentry.metrics.count("cli.get.provider", 1, {
      attributes: { ...attributes, provider: normalizeProviderSource(source) },
    });
  }
  for (const source of modules) {
    Sentry.metrics.count("cli.get.module", 1, {
      attributes: { ...attributes, module: classifyModuleSource(source) },
    });
  }
}

// `init` payload: the providers the new project was created with.
function sendInitTelemetry(entries: unknown[], attributes: Attributes): void {
  const providers = entries.flatMap((entry) => sourceOf(entry) ?? []);
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

// A run counts once as cli.command.invoked at start, then once as either
// cli.command.completed (with the scalars known only at the end) or
// cli.command.error; a nested operation (a deploy's synth) adds only its own.
async function commandAttributes(
  command: string,
  language: unknown,
): Promise<Attributes> {
  const ci: string | false = ciInfo.isCI ? ciInfo.name || "unknown" : false;
  const attributes: Attributes = {
    command,
    ci: ci === false ? false : ci,
    os: process.platform,
    arch: process.arch,
    ...(state.projectTargetAttributes ?? getProjectTargetAttributes()),
    ...(await getBinaryAttributes()),
  };
  if (LANGUAGES.includes(language as any)) {
    attributes.language = language as string;
  }
  return attributes;
}

/**
 * Counts the run as `cli.command.invoked` (an attempt, whatever its outcome).
 * Called once consent is captured and Sentry initialized; later calls in the
 * same process are no-ops.
 */
export async function startCommandTelemetry(
  command: string,
  projectPath = process.cwd(),
): Promise<void> {
  if (state.startedCommand !== undefined) {
    return;
  }
  state.startedCommand = command;
  state.language = readRawCdktfJson(projectPath).language;
  try {
    if (!isUsageTelemetryEnabled()) {
      return;
    }
    const attributes = await commandAttributes(command, state.language);
    Sentry.metrics.count("cli.command.invoked", 1, { attributes });
  } catch (err) {
    logger.debug(`Could not send telemetry data: ${err}`);
  }
}

/** Forgets the started run; tests run many commands in one process. */
export function resetCommandTelemetry(): void {
  state.startedCommand = undefined;
  state.language = undefined;
}

/**
 * Emits the usage telemetry of a finished command or operation as Sentry
 * metrics; payload fields reach the attributes only through the allow-lists
 * above. A silent no-op when usage telemetry is disabled or Sentry is not
 * initialized. `payload.error` counts the run as `cli.command.error` by
 * `errorType` instead.
 */
export async function sendTelemetry(
  command: string,
  payload: Record<string, any>,
): Promise<void> {
  try {
    if (!isUsageTelemetryEnabled()) {
      return;
    }

    const attributes = await commandAttributes(
      command,
      payload.language ?? state.language,
    );
    for (const [key, spec] of Object.entries(
      SCALAR_ATTRIBUTES[command] ?? {},
    )) {
      const value = scalarAttributeValue(payload[key], spec);
      if (value !== undefined) {
        attributes[spec.attribute] = value;
      }
    }

    if (payload.error) {
      attributes.error_type = COMMAND_ERROR_TYPES.includes(payload.errorType)
        ? payload.errorType
        : "unexpected";
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
    // a run with failed stacks is not completed: the failure thrown next is
    // counted as cli.command.error by the entrypoint's reporter
    const failedStackCount =
      typeof payload.failedStackCount === "number"
        ? payload.failedStackCount
        : 0;
    if (failedStackCount > 0) {
      Sentry.metrics.count("cli.stack.failed", failedStackCount, {
        attributes,
      });
    } else if (
      state.startedCommand === undefined ||
      state.startedCommand === command
    ) {
      Sentry.metrics.count("cli.command.completed", 1, { attributes });
    }
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
