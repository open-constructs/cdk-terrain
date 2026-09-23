/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { confirm } from "@inquirer/prompts";

export async function askForCrashReportingConsent() {
  return await confirm({
    message:
      "Do you want to send crash reports to the CDKTN team? Refer to https://cdktn.io/docs/telemetry#crash-reporting for more information",
    default: true,
  });
}

export async function askForUsageTelemetryConsent() {
  return await confirm({
    message:
      "Do you want to send anonymous usage telemetry (command, language, timing) to the CDKTN team? This enables the project to focus on what is actually used by the community to prioritize development. Refer to https://cdktn.io/docs/telemetry for more information",
    default: true,
  });
}
