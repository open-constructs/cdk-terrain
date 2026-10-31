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
      "Help us prioritize features and bolster regression tests: send anonymous usage telemetry (which commands you run, your language, tooling versions and platform; never your code, paths or resource names)? See https://cdktn.io/docs/telemetry",
    default: true,
  });
}
