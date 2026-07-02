// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  exec: jest.fn(),
}));

import { exec } from "@cdktn/commons";
import {
  getFetchingCliVersion,
  terraformInitWithRetry,
} from "../provider-schema";

const execMock = exec as unknown as jest.Mock;

function transientError(message = "502 Bad Gateway from github.com") {
  const err: any = new Error("non-zero exit code 1");
  err.stderr = message;
  return err;
}

function fatalError(message = "Error: Invalid provider version") {
  const err: any = new Error("non-zero exit code 1");
  err.stderr = message;
  return err;
}

describe("terraformInitWithRetry", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    execMock.mockReset();
    consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("returns immediately on first-attempt success", async () => {
    execMock.mockResolvedValueOnce("ok");

    const result = await terraformInitWithRetry({ cwd: "/tmp/x" }, 3, 0);

    expect(result).toBe("ok");
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("retries on transient stderr and eventually succeeds", async () => {
    execMock
      .mockRejectedValueOnce(transientError())
      .mockRejectedValueOnce(transientError("ECONNRESET"))
      .mockResolvedValueOnce("ok");

    const result = await terraformInitWithRetry({ cwd: "/tmp/x" }, 3, 0);

    expect(result).toBe("ok");
    expect(execMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-transient errors", async () => {
    execMock.mockRejectedValueOnce(fatalError());

    await expect(
      terraformInitWithRetry({ cwd: "/tmp/x" }, 3, 0),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Invalid") });

    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retries on persistent transient errors", async () => {
    execMock.mockRejectedValue(transientError("503 Service Unavailable"));

    await expect(
      terraformInitWithRetry({ cwd: "/tmp/x" }, 3, 0),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("503") });

    expect(execMock).toHaveBeenCalledTimes(3);
  });
});

describe("getFetchingCliVersion", () => {
  it("execs `terraform version` once and memoizes the result", async () => {
    execMock.mockReset();
    execMock.mockResolvedValue("Terraform v1.7.5\non linux_amd64\n");

    const first = await getFetchingCliVersion();
    const second = await getFetchingCliVersion();

    expect(first).toEqual({ name: "terraform", version: "1.7.5" });
    expect(second).toBe(first);
    expect(execMock).toHaveBeenCalledTimes(1);
  });
});
