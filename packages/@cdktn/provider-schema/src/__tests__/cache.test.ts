// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { cachedAccess } from "../cache";

describe("cachedAccess", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-schema-cache-"));
  });

  afterEach(() => {
    fs.removeSync(cacheDir);
  });

  it("writes to a suffix-qualified cache file when a keySuffix is given", async () => {
    const producer = jest.fn().mockResolvedValue({ hello: "world" });
    const access = cachedAccess(producer, cacheDir, "terraform-1.7");

    await access({ fqn: "hashicorp/null", version: "3.1.0" } as any);

    const files = fs.readdirSync(cacheDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("terraform-1.7");
  });

  it("keeps distinct cache files for distinct suffixes", async () => {
    const producerA = jest.fn().mockResolvedValue({ v: "a" });
    const producerB = jest.fn().mockResolvedValue({ v: "b" });

    const input = { fqn: "hashicorp/null", version: "3.1.0" } as any;

    await cachedAccess(producerA, cacheDir, "terraform-1.7")(input);
    await cachedAccess(producerB, cacheDir, "terraform-1.15")(input);

    const files = fs.readdirSync(cacheDir);
    expect(files).toHaveLength(2);
    expect(producerA).toHaveBeenCalledTimes(1);
    expect(producerB).toHaveBeenCalledTimes(1);
  });

  it("hits the same cache file on repeated calls with the same suffix", async () => {
    const producer = jest.fn().mockResolvedValue({ v: "a" });
    const input = { fqn: "hashicorp/null", version: "3.1.0" } as any;
    const access = cachedAccess(producer, cacheDir, "terraform-1.7");

    await access(input);
    await access(input);

    expect(producer).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(cacheDir)).toHaveLength(1);
  });

  it("stays backward-compatible without a keySuffix", async () => {
    const producer = jest.fn().mockResolvedValue({ hello: "world" });
    const access = cachedAccess(producer, cacheDir);

    await access({ fqn: "hashicorp/null", version: "3.1.0" } as any);

    const files = fs.readdirSync(cacheDir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("undefined");
  });
});
