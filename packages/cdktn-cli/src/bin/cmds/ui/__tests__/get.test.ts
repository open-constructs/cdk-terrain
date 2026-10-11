// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as Sentry from "@sentry/node";
import {
  ConstructsMakerModuleTarget,
  ConstructsMakerProviderTarget,
  Errors,
  Language,
  TerraformModuleConstraint,
  TerraformProviderConstraint,
  seedTerraformCliProbeForTests,
} from "@cdktn/commons";

jest.mock("@sentry/node", () => ({
  getCurrentScope: jest.fn(() => ({ setTransactionName: jest.fn() })),
  metrics: { count: jest.fn(), distribution: jest.fn() },
}));

const mockGet = jest.fn();
jest.mock("@cdktn/cli-core", () => ({
  ...jest.requireActual("@cdktn/cli-core"),
  get: (...args: unknown[]) => mockGet(...args),
}));

jest.mock("../../helper/tty-stream", () => ({
  StreamRenderer: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    setBar: jest.fn(),
  })),
}));

import { runGet } from "../get";

const config = {
  codeMakerOutput: ".gen",
  language: Language.TYPESCRIPT,
  constraints: [],
  parallelism: 1,
  silent: true,
};

describe("runGet telemetry", () => {
  let errorSpy: jest.SpyInstance;
  const count = Sentry.metrics.count as jest.Mock;
  const originalCheckpointDisable = process.env.CHECKPOINT_DISABLE;

  beforeEach(() => {
    mockGet.mockReset();
    count.mockClear();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    // the jest preset disables usage telemetry process-wide
    delete process.env.CHECKPOINT_DISABLE;
    seedTerraformCliProbeForTests(Promise.resolve("Terraform v1.9.0\n"));
  });

  afterEach(() => {
    errorSpy.mockRestore();
    Errors.setScope("unknown");
    seedTerraformCliProbeForTests();
    if (originalCheckpointDisable !== undefined) {
      process.env.CHECKPOINT_DISABLE = originalCheckpointDisable;
    }
  });

  it("counts the generated targets on the get metrics", async () => {
    const targets = [
      new ConstructsMakerProviderTarget(
        new TerraformProviderConstraint("aws@~> 5.0"),
        Language.TYPESCRIPT,
      ),
      new ConstructsMakerModuleTarget(
        new TerraformModuleConstraint("./modules/vpc"),
        Language.TYPESCRIPT,
      ),
    ];
    mockGet.mockImplementation(async ({ reportTelemetry }) => {
      for (const target of targets) {
        await reportTelemetry({
          targetLanguage: "typescript",
          trackingPayload: target.trackingPayload,
        });
      }
    });

    await runGet(config);

    const counted = (attributes: Record<string, unknown>) => ({
      attributes: expect.objectContaining(attributes),
    });
    expect(count.mock.calls).toEqual([
      [
        "cli.command.completed",
        1,
        counted({
          command: "get",
          language: "typescript",
          provider_count: 1,
          module_count: 1,
        }),
      ],
      ["cli.get.provider", 1, counted({ provider: "hashicorp/aws" })],
      ["cli.get.module", 1, counted({ module: "local" })],
    ]);
  });

  it("rethrows a generation failure without counting it: the entrypoint counts the run", async () => {
    const failure = Errors.External("schema fetch failed");
    count.mockClear();
    mockGet.mockRejectedValue(failure);

    await expect(runGet(config)).rejects.toBe(failure);

    expect(count).not.toHaveBeenCalled();
  });
});
