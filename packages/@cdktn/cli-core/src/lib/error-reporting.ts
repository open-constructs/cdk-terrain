// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as Sentry from "@sentry/node";
import {
  Errors,
  getProjectId,
  getUserId,
  getUsageTelemetryConsent,
  getProjectTargetAttributes,
  hasCapturedUsageTelemetryDecision,
  setProjectTargetAttributes,
  setUsageTelemetryEnabled,
  startCommandTelemetry,
  collectDebugInformation,
  DISPLAY_VERSION,
  normalizeConsentFlag,
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

    // undefined means "unset" and lets the caller prompt; false (the catch
    // below) means no readable cdktf.json, so no crash reporting
    if (!("sendCrashReports" in cdktfJson)) {
      return undefined;
    }

    return normalizeConsentFlag("sendCrashReports", cdktfJson.sendCrashReports);
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

function persistSendUsageTelemetryDecision(
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

// projectPath is the project whose consent flags apply; init passes the one
// it just created.
export async function initializErrorReporting(
  runCrashConsentPrompt?: () => Promise<boolean>,
  runUsageTelemetryConsentPrompt?: () => Promise<boolean>,
  projectPath = process.cwd(),
) {
  // The first call decides for the whole process: a command run by another
  // one (get inside the throwaway project of convert) must not replace the
  // consent, or the client built from it, with those of its own project.
  if (hasCapturedUsageTelemetryDecision()) {
    return;
  }

  let shouldReport = shouldReportCrash(projectPath);
  let usageConsent = getUsageTelemetryConsent(projectPath);

  // stdin must be a TTY as well: a prompt would consume the input `convert`
  // reads from it. Without a cdktf.json there is nowhere to persist the answer.
  const canPrompt =
    Boolean(process.stdin.isTTY) &&
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

  // unset means: crash reporting off (opt-in), usage telemetry on (opt-out)
  const crashReportingEnabled = shouldReport === true;
  const usageTelemetryEnabled =
    !process.env.CHECKPOINT_DISABLE && usageConsent !== false;

  // captured in the user's cwd; see CommandTelemetryState in commons
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
    // metrics are delivered independently of trace sampling
    tracesSampleRate: 0,
    // Fixed constant so the machine hostname is never attached to events or
    // metrics (v10 defaults server_name/server.address to the hostname).
    serverName: "cdktn-cli",
    // explicit, so a change of the SDK default cannot silently stop delivery
    enableMetrics: true,
    async beforeSend(event, hint) {
      // Crash events need their own consent: with usage-only consent every
      // error event is dropped (metrics do not pass through beforeSend).
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
    // not awaited: an unhandled rejection here would crash the CLI
    collectDebugInformation()
      .then((debugOutput) => {
        Sentry.setContext("environment", debugOutput);
      })
      .catch((e) => {
        logger.debug(`Could not collect environment information: ${e}`);
      });
  }

  // every command calls Errors.setScope before this, so the scope is the command
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
