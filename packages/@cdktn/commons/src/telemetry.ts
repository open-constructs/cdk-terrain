// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { normalizeConsentFlag } from "./config";
import * as Sentry from "@sentry/node";
import * as path from "path";
import * as fs from "fs-extra";
import * as semver from "semver";
import ciInfo from "ci-info";
import { logger } from "./logging";
import {
  DEFAULT_TARGET_VERSIONS,
  Language,
  LANGUAGES,
  isLocalModule,
} from "./config";
import { isGradleProject } from "./gradle";
import { detectNodePackageManager } from "./node-package-manager";
import { processState } from "./process-state";
import { isRegistryModule } from "./terraform-module";
import { terraformCli } from "./terraform";

type AttributeValue = string | number | boolean;
type Attributes = Record<string, AttributeValue>;

export const COMMAND_ERROR_TYPES = [
  "Usage",
  "External",
  "Internal",
  "unexpected",
] as const;
export type CommandErrorType = (typeof COMMAND_ERROR_TYPES)[number];

// Never throws: telemetry also runs outside a project. Raw, because commons
// cannot import cli-core's typed config.
function readRawCdktfJson(projectPath: string): Record<string, any> {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(projectPath, "cdktf.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

// undefined: unset, malformed, or no readable cdktf.json
export function getUsageTelemetryConsent(
  projectPath = process.cwd(),
): boolean | undefined {
  const cdktfJson = readRawCdktfJson(projectPath);
  if (!("sendUsageTelemetry" in cdktfJson)) {
    return undefined;
  }
  return normalizeConsentFlag(
    "sendUsageTelemetry",
    cdktfJson.sendUsageTelemetry,
  );
}

type CommandTelemetryState = {
  // Captured by initializErrorReporting (cli-core) while still in the user's
  // cwd: `convert` chdirs into a throwaway project before emitting, so
  // re-reading cdktf.json at emission time would consult the wrong project.
  usageTelemetryEnabled?: boolean;
  // The command this run was started as; set once by startCommandTelemetry so
  // the operations a command drives (a deploy's synth, the get of init or
  // provider add) never count as runs.
  startedCommand?: string;
  // The raw `language` of the project the run started in, so every metric of
  // the run (the error metric has no payload) carries the one `invoked` did.
  language?: unknown;
  // detected in the project the run started in, for the same reason
  packageManager?: PackageManager;
  // captured with the consent decision, for the same reason
  projectTargetAttributes?: Attributes;
  // Captured at start like `language`: the bindings the started project
  // generates, whatever directory the run is in when it reports its stacks.
  generatedProviderSources?: string[];
  // A run reports its stacks once: a watch session redeploys the same app
  // for hours and would repeat them on every file change.
  stackMetricsSent?: boolean;
};

// Shared by both bundle copies: the handlers' copy captures the decision and
// starts the run, the entrypoint's copy counts the failure.
const state = processState<CommandTelemetryState>(
  "cdktn.commandTelemetry",
  () => ({}),
);

export const PACKAGE_MANAGERS = [
  "npm",
  "pnpm",
  "yarn",
  "yarn-berry",
  "pip",
  "pipenv",
  "maven",
  "gradle",
  "nuget",
  "go",
] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

// Only members of the closed set become an attribute: a `packageManager`
// field carries a version and a hash, and a detector may grow new values.
export function normalizePackageManager(
  value: unknown,
): PackageManager | undefined {
  return PACKAGE_MANAGERS.find((name) => name === value);
}

// The package manager `provider add` would drive, decided the way cli-core's
// PackageManager.forLanguage does. undefined outside a supported project.
function detectPackageManager(
  projectPath: string,
  cdktfJson: Record<string, any>,
): PackageManager | undefined {
  try {
    switch (cdktfJson.language) {
      case Language.TYPESCRIPT:
        return normalizePackageManager(detectNodePackageManager(projectPath));
      case Language.PYTHON:
        if (typeof cdktfJson.app !== "string") {
          return undefined;
        }
        return cdktfJson.app.includes("pipenv") ? "pipenv" : "pip";
      case Language.JAVA:
        return isGradleProject(projectPath) ? "gradle" : "maven";
      case Language.CSHARP:
        return "nuget";
      case Language.GO:
        return "go";
      default:
        return undefined;
    }
  } catch (err) {
    logger.debug(`Could not detect the package manager: ${err}`);
    return undefined;
  }
}

// Free-text payload fields are validated before they become attributes so a
// misconfigured or hand-edited value never carries arbitrary text.
const CONSTRAINT_PART = /^(=|!=|>=|<=|>|<|~>)?\s*(\d+(?:\.\d+){0,2})$/;
const RELEASE_VERSION = /^\d+\.\d+\.\d+/;

// Terraform's built-in backend kinds; anything else is sent as "other"
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

function normalizeBackendKind(backend: unknown): string {
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

// Normalized so spacing variants collapse into one value. Hyphen ranges are
// written " - ", so a hyphen right after a digit is always a prerelease:
// free text (see releaseVersion), which rejects the range.
function semverRangeOrInvalid(value: string): string {
  const range = value.length <= 64 ? semver.validRange(value) : null;
  return range && !/\d[-+]/.test(value) ? range : "invalid";
}

// Re-joined as "~> 5.0, != 5.1.0" so spacing variants are one value. The
// constraint is user-authored, so a prerelease identifier or an over-long
// value rejects it whole.
function normalizeProviderConstraint(value: string): string {
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

// Once captured, the decision stands for the process; reporting is not
// initialized a second time.
export function hasCapturedUsageTelemetryDecision(): boolean {
  return state.usageTelemetryEnabled !== undefined;
}

// Precedence: CHECKPOINT_DISABLE > the decision captured at command start >
// `sendUsageTelemetry` in cdktf.json > enabled.
export function isUsageTelemetryEnabled(projectPath = process.cwd()): boolean {
  if (process.env.CHECKPOINT_DISABLE) {
    return false;
  }
  if (state.usageTelemetryEnabled !== undefined) {
    return state.usageTelemetryEnabled;
  }
  return getUsageTelemetryConsent(projectPath) !== false;
}

// Falls back to the CLI defaults, so every metric carries the ranges the
// command validated against.
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

async function getBinaryAttributes(): Promise<Attributes> {
  const cli = await terraformCli();
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
}

// By type and command only: message and context can carry paths and user
// input.
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

// Call before an explicit process.exit(): Sentry buffers asynchronously and
// a hard exit drops the buffer.
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

// Only a public-registry `namespace/type` is sent (`aws`, `hashicorp/aws@~>5`
// and `registry.terraform.io/hashicorp/aws` are one); other hosts become
// "private-registry", paths and malformed input "other".
function normalizeProviderSource(source: string): string {
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

// From `terraformProviders` in cdktf.json (`"aws@~>5.0"` strings or
// `{ name, source }` objects); a stack provider not listed there is prebuilt.
function getGeneratedProviderSources(projectPath = process.cwd()): string[] {
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

function classifyProviderBinding(
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

// Only public registry sources are sent as-is; anything else could carry a
// path, hostname, bucket or organization and is reduced to its kind.
function classifyModuleSource(source: string): string {
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

/** What triggered a synth other than the command itself. */
export const SYNTH_ORIGINS = ["watch"] as const;
export type SynthOrigin = (typeof SYNTH_ORIGINS)[number];

type ScalarAttribute = {
  attribute: string;
  type: "string" | "number" | "boolean";
  /** Enumerated values; a value outside the set is dropped. */
  values?: readonly string[];
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
  spec: Pick<ScalarAttribute, "type" | "values">,
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

// `overrides: { aws_s3_bucket: ["tags", "region"] }` gives { aws_s3_bucket: 2 }
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

// Distinct identities reported per metric and run. A project's size must not
// decide how many events one run sends, so the rest folds into one event.
const MAX_STACK_GROUPS = 8;
const MAX_STACK_PROVIDERS = 32;
const MAX_STACK_OVERRIDE_TYPES = 32;
const MAX_BINDING_SOURCES = 32;

// What an aggregated metric adds to the command attributes, with the type
// each must have; anything else stays out of the metric.
const AGGREGATE_ATTRIBUTES: Record<
  string,
  Record<string, ScalarAttribute["type"]>
> = {
  "cli.stack": {
    backend: "string",
    cloud: "boolean",
    library_version: "string",
    override_count: "number",
    import_count: "number",
    moved_count: "number",
    truncated: "boolean",
  },
  "cli.stack.provider": {
    provider: "string",
    version_constraint: "string",
    binding: "string",
    truncated: "boolean",
  },
  "cli.stack.override": {
    resource_type: "string",
    override_count: "number",
    truncated: "boolean",
  },
  "cli.get.provider": { provider: "string", truncated: "boolean" },
  "cli.get.module": { module: "string", truncated: "boolean" },
  "cli.init.provider": { provider: "string", truncated: "boolean" },
};

type MetricGroup = {
  identity: Attributes;
  sums: Record<string, number>;
  value: number;
  lastMember?: number;
};
type MetricGroups = Map<string, MetricGroup>;

function addSums(target: Record<string, number>, sums: Record<string, number>) {
  for (const [name, count] of Object.entries(sums)) {
    target[name] = (target[name] ?? 0) + count;
  }
}

// The identity must hold normalised values only: grouping on a raw source
// would send one event per distinct private host. A member (a stack) that
// reaches a group twice is counted once.
function countInto(
  groups: MetricGroups,
  member: number,
  identity: Attributes,
  sums: Record<string, number> = {},
): void {
  const key = JSON.stringify(identity);
  let group = groups.get(key);
  if (!group) {
    group = { identity, sums: {}, value: 0 };
    groups.set(key, group);
  }
  if (group.lastMember !== member) {
    group.lastMember = member;
    group.value += 1;
  }
  addSums(group.sums, sums);
}

// One counter per group, the most counted first (ties by identity, so the
// kept set is stable); the groups past `limit` fold into one event without
// identity, which keeps the metric's total.
function emitGroups(
  metric: string,
  limit: number,
  groups: MetricGroups,
  attributes: Attributes,
): void {
  const sorted = [...groups.entries()]
    .sort(([keyA, a], [keyB, b]) => b.value - a.value || (keyA < keyB ? -1 : 1))
    .map(([, group]) => group);
  const emitted = sorted.slice(0, limit);
  const folded = sorted.slice(limit);
  if (folded.length > 0) {
    const residual: MetricGroup = {
      identity: { truncated: true },
      sums: {},
      value: 0,
    };
    for (const group of folded) {
      residual.value += group.value;
      addSums(residual.sums, group.sums);
    }
    emitted.push(residual);
  }
  const allowed = AGGREGATE_ATTRIBUTES[metric];
  for (const group of emitted) {
    const own: Attributes = {};
    for (const [name, raw] of Object.entries({
      ...group.identity,
      ...group.sums,
    })) {
      const value =
        name in allowed
          ? scalarAttributeValue(raw, { type: allowed[name] })
          : undefined;
      if (value !== undefined) {
        own[name] = value;
      }
    }
    Sentry.metrics.count(metric, group.value, {
      attributes: { ...attributes, ...own },
    });
  }
}

// counts and allow-listed kinds only, never names or ids
function sendStackTelemetry(
  stackMetadata: unknown[],
  requiredProviders: unknown[],
  attributes: Attributes,
): void {
  const generatedSources =
    state.generatedProviderSources ?? getGeneratedProviderSources();
  const stacks: MetricGroups = new Map();
  const overrides: MetricGroups = new Map();
  const providers: MetricGroups = new Map();
  stackMetadata.forEach((entry, index) => {
    // a null or non-object entry is not a stack: counting one would inflate
    // the stack count with metadata the library never wrote
    if (!entry || typeof entry !== "object") {
      return;
    }
    const metadata = entry as Record<string, any>;
    const overrideSizes = groupSizes(metadata.overrides);
    const stack: Attributes = {
      backend: normalizeBackendKind(metadata.backend),
      cloud: typeof metadata.cloud === "string",
    };
    const libraryVersion = releaseVersion(metadata.version);
    if (libraryVersion) {
      stack.library_version = libraryVersion;
    }
    countInto(stacks, index, stack, {
      override_count: sum(overrideSizes),
      import_count: sum(groupSizes(metadata.imports)),
      moved_count: sum(groupSizes(metadata.moved)),
    });

    for (const [key, count] of Object.entries(overrideSizes)) {
      countInto(
        overrides,
        index,
        { resource_type: overrideResourceType(key) },
        { override_count: count },
      );
    }

    const required = requiredProviders[index];
    if (!required || typeof required !== "object") {
      return;
    }
    for (const [type, constraint] of Object.entries(
      required as Record<string, any>,
    )) {
      const source =
        typeof constraint?.source === "string" ? constraint.source : type;
      const provider: Attributes = {
        provider: normalizeProviderSource(source),
      };
      if (typeof constraint?.version === "string") {
        provider.version_constraint = normalizeProviderConstraint(
          constraint.version,
        );
      }
      provider.binding = classifyProviderBinding(source, generatedSources);
      countInto(providers, index, provider);
    }
  });
  emitGroups("cli.stack", MAX_STACK_GROUPS, stacks, attributes);
  emitGroups("cli.stack.provider", MAX_STACK_PROVIDERS, providers, attributes);
  emitGroups(
    "cli.stack.override",
    MAX_STACK_OVERRIDE_TYPES,
    overrides,
    attributes,
  );
}

function sendSourceTelemetry(
  metric: string,
  attribute: string,
  sources: string[],
  normalize: (source: string) => string,
  attributes: Attributes,
): void {
  const groups: MetricGroups = new Map();
  sources.forEach((source, index) =>
    countInto(groups, index, { [attribute]: normalize(source) }),
  );
  emitGroups(metric, MAX_BINDING_SOURCES, groups, attributes);
}

// targets: one `{ type, source }` per generated binding
function targetSources(targets: any[], type: string): string[] {
  return targets
    .filter((target) => target?.type === type)
    .map((target) => target.source);
}

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
  if (state.packageManager !== undefined) {
    attributes.package_manager = state.packageManager;
  }
  return attributes;
}

// Counts the attempt, whatever its outcome. Runs after consent is captured
// and Sentry initialized; later calls in the same process are no-ops.
export async function startCommandTelemetry(
  command: string,
  projectPath = process.cwd(),
): Promise<void> {
  if (state.startedCommand !== undefined) {
    return;
  }
  state.startedCommand = command;
  const cdktfJson = readRawCdktfJson(projectPath);
  state.language = cdktfJson.language;
  state.packageManager = detectPackageManager(projectPath, cdktfJson);
  state.generatedProviderSources = getGeneratedProviderSources(projectPath);
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
  state.packageManager = undefined;
  state.generatedProviderSources = undefined;
  state.stackMetricsSent = undefined;
}

// Payload fields reach the attributes only through the allow-lists above.
// A no-op when usage telemetry is disabled or Sentry is not initialized;
// `payload.error` counts the run as cli.command.error instead.
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

    const generated =
      command === "get" && Array.isArray(payload.targets)
        ? {
            providers: targetSources(payload.targets, "provider"),
            modules: targetSources(payload.targets, "module"),
          }
        : undefined;
    const addedProviders: string[] | undefined =
      command === "init" && Array.isArray(payload.addedProviders)
        ? payload.addedProviders
        : undefined;
    if (generated) {
      attributes.provider_count = generated.providers.length;
      attributes.module_count = generated.modules.length;
    }
    if (addedProviders) {
      attributes.provider_count = addedProviders.length;
    }

    // The run's outcome goes first: nothing in the per-source and stack
    // metrics below can then cost the run its command metric.
    const nested =
      state.startedCommand !== undefined && state.startedCommand !== command;
    // a run that failed, with or without a failed stack, is not completed: the
    // failure thrown next is counted as cli.command.error by the entrypoint's
    // reporter
    const failedStackCount =
      typeof payload.failedStackCount === "number"
        ? payload.failedStackCount
        : 0;
    if (failedStackCount > 0) {
      Sentry.metrics.count("cli.stack.failed", failedStackCount, {
        attributes,
      });
    } else if (!nested && payload.runFailed !== true) {
      Sentry.metrics.count("cli.command.completed", 1, { attributes });
    }
    if (typeof payload.totalTime === "number") {
      Sentry.metrics.distribution("cli.synth.duration", payload.totalTime, {
        unit: "millisecond",
        attributes,
      });
    }

    if (generated) {
      sendSourceTelemetry(
        "cli.get.provider",
        "provider",
        generated.providers,
        normalizeProviderSource,
        attributes,
      );
      sendSourceTelemetry(
        "cli.get.module",
        "module",
        generated.modules,
        classifyModuleSource,
        attributes,
      );
    }
    if (addedProviders) {
      sendSourceTelemetry(
        "cli.init.provider",
        "provider",
        addedProviders,
        normalizeProviderSource,
        attributes,
      );
    }
    // A synth nested in another command describes every stack of the app;
    // the command reports the stacks it selected, under its own name.
    if (
      Array.isArray(payload.stackMetadata) &&
      !state.stackMetricsSent &&
      !(nested && command === "synth")
    ) {
      state.stackMetricsSent = true;
      sendStackTelemetry(
        payload.stackMetadata,
        Array.isArray(payload.requiredProviders)
          ? payload.requiredProviders
          : [],
        attributes,
      );
    }
  } catch (err) {
    logger.debug(`Could not send telemetry data: ${err}`);
  }
}
