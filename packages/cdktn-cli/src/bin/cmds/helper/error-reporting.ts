/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { confirm } from "@inquirer/prompts";

export async function askForCrashReportingConsent() {
  return await confirm({
    message:
      "Do you want to send crash reports to the CDKTN team? Refer to https://cdktn.io/docs/create-and-deploy/configuration-file#enable-crash-reporting-for-the-cli for more information",
    default: true,
  });
}

export async function askForUsageTelemetryConsent() {
  return await confirm({
    message:
      "Do you want to send anonymous usage telemetry (command, language, timing) to the CDKTN team? Refer to https://cdktn.io/docs/telemetry for more information",
    default: true,
  });
}
