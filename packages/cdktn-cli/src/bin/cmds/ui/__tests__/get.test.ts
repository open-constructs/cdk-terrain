// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Errors, Language } from "@cdktn/commons";

const mockGet = jest.fn();
jest.mock("@cdktn/cli-core", () => ({
  ...jest.requireActual("@cdktn/cli-core"),
  get: (...args: unknown[]) => mockGet(...args),
}));

const mockSendTelemetry = jest.fn().mockResolvedValue(undefined);
jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  sendTelemetry: (...args: unknown[]) => mockSendTelemetry(...args),
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

  beforeEach(() => {
    mockGet.mockReset();
    mockSendTelemetry.mockClear();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    Errors.setScope("unknown");
  });

  it("sends one get metric on success", async () => {
    mockGet.mockResolvedValue(undefined);

    await runGet(config);

    expect(mockSendTelemetry).toHaveBeenCalledTimes(1);
    expect(mockSendTelemetry).toHaveBeenCalledWith("get", {
      language: "typescript",
    });
  });

  it("rethrows a generation failure without counting it: the entrypoint counts the run", async () => {
    const failure = Errors.External("schema fetch failed");
    mockGet.mockRejectedValue(failure);

    await expect(runGet(config)).rejects.toBe(failure);

    expect(mockSendTelemetry).not.toHaveBeenCalled();
  });
});
