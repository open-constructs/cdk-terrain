// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as Sentry from "@sentry/node";
import {
  Errors,
  getProjectId,
  getUserId,
  getUsageTelemetryConsent,
  getProjectTargetAttributes,
  setProjectTargetAttributes,
  setUsageTelemetryEnabled,
  startCommandTelemetry,
  collectDebugInformation,
  DISPLAY_VERSION,
} from "@cdktn/commons";
import { logger } from "@cdktn/commons";
import * as path from "path";
import * as fs from "fs-extra";
import { randomUUID } from "node:crypto";
import ciInfo from "ci-info";

export function shouldReportCrash(
  projectPath = process.cwd(),
): boolean | undefined {
  try {
    const cdktfJson = JSON.parse(
      fs.readFileSync(path.resolve(projectPath, "cdktf.json"), "utf8"),
    );

    // tri-state: an absent flag means "unset" and triggers the
    // interactive consent prompt; outside a project (no readable
    // cdktf.json) crash reporting stays off
    if (!("sendCrashReports" in cdktfJson)) {
      return undefined;
    }

    return typeof cdktfJson.sendCrashReports === "boolean"
      ? cdktfJson.sendCrashReports
      : cdktfJson.sendCrashReports === "true";
  } catch (e) {
    logger.debug(
      `Error determining if crash reporting should be enabled, defaulting to false: ${e}`,
    );
    return false;
  }
}

function persistConsentDecision(
  key: "sendCrashReports" | "sendUsageTelemetry",
  decision: boolean,
  projectPath = process.cwd(),
) {
  const cdktfJson = JSON.parse(
    fs.readFileSync(path.resolve(projectPath, "cdktf.json"), "utf8"),
  );
  cdktfJson[key] = decision;
  fs.writeFileSync(
    path.resolve(projectPath, "cdktf.json"),
    JSON.stringify(cdktfJson, null, 2),
  );
}

export function persistReportCrashReportDecision(
  decision: boolean,
  projectPath = process.cwd(),
) {
  persistConsentDecision("sendCrashReports", decision, projectPath);
}

export function persistSendUsageTelemetryDecision(
  decision: boolean,
  projectPath = process.cwd(),
) {
  persistConsentDecision("sendUsageTelemetry", decision, projectPath);
}

function isPromise(p: any): p is Promise<any> {
  return (
    typeof p === "object" &&
    typeof p.then === "function" &&
    typeof p.catch === "function"
  );
}

/**
 * `projectPath` is the project whose consent flags apply: the cwd for every
 * command, the freshly created project for `init`.
 */
export async function initializErrorReporting(
  runCrashConsentPrompt?: () => Promise<boolean>,
  runUsageTelemetryConsentPrompt?: () => Promise<boolean>,
  projectPath = process.cwd(),
) {
  let shouldReport = shouldReportCrash(projectPath);
  let usageConsent = getUsageTelemetryConsent(projectPath);

  // Prompting requires a real user at a terminal (TTY and not CI) and a
  // cdktf.json to persist the decision into; otherwise fall through to
  // the per-flag non-interactive defaults below.
  const canPrompt =
    Boolean(process.stdout.isTTY) &&
    !ciInfo.isCI &&
    !process.env.CI &&
    fs.existsSync(path.resolve(projectPath, "cdktf.json"));

  if (canPrompt) {
    if (shouldReport === undefined && runCrashConsentPrompt) {
      shouldReport = await runCrashConsentPrompt();
      persistReportCrashReportDecision(shouldReport, projectPath);
    }
    if (
      usageConsent === undefined &&
      runUsageTelemetryConsentPrompt &&
      !process.env.CHECKPOINT_DISABLE
    ) {
      usageConsent = await runUsageTelemetryConsentPrompt();
      persistSendUsageTelemetryDecision(usageConsent, projectPath);
    }
  }

  // Non-interactive defaults: crash reporting is opt-in (off), usage
  // telemetry is on unless CHECKPOINT_DISABLE is set.
  const crashReportingEnabled = shouldReport === true;
  const usageTelemetryEnabled =
    !process.env.CHECKPOINT_DISABLE && usageConsent !== false;

  // Capture the decision while we are still in the user's working
  // directory: some commands (convert) chdir into a temporary project
  // before sendTelemetry runs and must not consult that project's flags.
  setUsageTelemetryEnabled(usageTelemetryEnabled);
  setProjectTargetAttributes(getProjectTargetAttributes(projectPath));

  if (!crashReportingEnabled && !usageTelemetryEnabled) {
    logger.debug("Error reporting and usage telemetry disabled");
    return;
  }
  if (!process.env.SENTRY_DSN) {
    logger.info("Reporting disabled: SENTRY_DSN not set");
    return;
  }

  logger.debug("Initializing reporting");

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: `cdktn-cli-${DISPLAY_VERSION}`,
    // Fixed so the SDK never falls back to the user's SENTRY_ENVIRONMENT.
    environment: "production",
    // Usage metrics are delivered independently of trace sampling, so no
    // trace quota is spent.
    tracesSampleRate: 0,
    // Fixed constant so the machine hostname is never attached to events or
    // metrics (v10 defaults server_name/server.address to the hostname).
    serverName: "cdktn-cli",
    // Usage metrics ride on the SDK's metrics pipeline; explicit so a future
    // SDK default flip cannot silently stop delivery.
    enableMetrics: true,
    async beforeSend(event, hint) {
      // Error/crash events require their own consent: when Sentry is
      // initialized only for usage metrics, drop every error event
      // (metrics do not pass through beforeSend).
      if (!crashReportingEnabled) {
        return null;
      }
      if (!hint) {
        return event;
      }

      // The promise character is not documented, but it happens
      const originalException:
        Promise<Error> | Error | string | null | undefined | unknown =
        hint.originalException;
      let error: Error | string | null | undefined | unknown;
      if (isPromise(originalException)) {
        (originalException as unknown as Promise<Error>).catch(
          (e) => (error = e),
        );
        await Promise.allSettled([originalException]);
      } else {
        error = originalException;
      }

      const errorMessage = error?.toString() || "";
      if (errorMessage.includes("Usage Error")) {
        // This is a usage error, so we don't want to report it
        return null;
      }
      return event;
    },
  });

  const scope = Sentry.getCurrentScope();
  // The SDK seeds the trace from SENTRY_TRACE/SENTRY_BAGGAGE; start a fresh
  // one so nothing from the user's environment propagates.
  scope.setPropagationContext({
    traceId: randomUUID().replace(/-/g, ""),
    sampleRand: Math.random(),
  });
  scope.setUser({
    id: getUserId(),
  });
  scope.setTag("projectId", getProjectId());

  if (crashReportingEnabled) {
    logger.debug("Collecting environment information for error reporting");
    collectDebugInformation().then((debugOutput) => {
      Sentry.setContext("environment", debugOutput);
    });
  }

  // The run is counted as started here, under the command scope every
  // command sets before it initializes reporting.
  await startCommandTelemetry(Errors.getScope(), projectPath);
}

export function captureException({
  message,
  type,
  command,
  context,
}: {
  message: string;
  type: string;
  command: string;
  context?: Record<string, any>;
}) {
  if (process.env.SENTRY_DSN && shouldReportCrash()) {
    Sentry.captureException(new Error(message), {
      tags: {
        context: JSON.stringify(context),
        type,
        command,
      },
    });
  }
}
