// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

jest.mock("@cdktn/cli-core", () => {
  const actual = jest.requireActual("@cdktn/cli-core");
  return {
    ...actual,
    init: jest.fn().mockResolvedValue(false),
    initializErrorReporting: jest.fn().mockResolvedValue(undefined),
    CdktfConfig: {
      read: jest.fn(() => ({
        language: "typescript",
        codeMakerOutput: ".gen",
      })),
    },
  };
});

jest.mock("../terraform-check", () => ({
  getTerraformVersion: jest.fn().mockResolvedValue(undefined),
  terraformCheck: jest.fn().mockResolvedValue(undefined),
}));

import { initializErrorReporting } from "@cdktn/cli-core";
import { setUsageTelemetryEnabled } from "@cdktn/commons";
import { runInit } from "../init";

describe("runInit telemetry wiring", () => {
  let destination: string;

  const init = () =>
    runInit({
      destination,
      local: true,
      silent: true,
      nonInteractive: true,
      template: "typescript",
      projectName: "test",
      projectDescription: "test",
      fromTerraformProject: "no",
      enableCrashReporting: false,
      enableUsageTelemetry: true,
      providers: ["aws"],
    });

  beforeEach(() => {
    jest.clearAllMocks();
    destination = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-init-"));
    setUsageTelemetryEnabled(undefined);
  });

  afterEach(() => {
    setUsageTelemetryEnabled(undefined);
    fs.removeSync(destination);
  });

  it("initializes reporting against the destination and returns the init metric payload", async () => {
    const { telemetry } = await init();

    expect(initializErrorReporting).toHaveBeenCalledWith(
      undefined,
      undefined,
      path.resolve(destination),
    );
    expect(telemetry).toEqual({
      template: "typescript",
      addedProviders: ["aws"],
      language: "typescript",
    });
  });

  it("leaves an already captured decision alone (convert drives init in a throwaway project)", async () => {
    setUsageTelemetryEnabled(false);

    await init();

    expect(initializErrorReporting).not.toHaveBeenCalled();
  });
});
