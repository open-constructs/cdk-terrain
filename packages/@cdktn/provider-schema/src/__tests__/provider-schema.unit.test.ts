// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

jest.mock("@cdktn/commons", () => ({
  ...jest.requireActual("@cdktn/commons"),
  exec: jest.fn(),
}));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { exec } from "@cdktn/commons";
import {
  TerraformConfig,
  applyModuleProviderAliases,
  collectModuleProviderAliases,
  fetchedModuleDir,
  getFetchingCliVersion,
  packageSubdir,
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

describe("collectModuleProviderAliases", () => {
  it("returns nothing for a module without required_providers", () => {
    expect(collectModuleProviderAliases({ variable: { foo: [{}] } })).toEqual(
      [],
    );
  });

  it("returns nothing for required providers without configuration aliases", () => {
    const parsed = {
      terraform: [
        { required_providers: [{ aws: { source: "hashicorp/aws" } }] },
      ],
    };

    expect(collectModuleProviderAliases(parsed)).toEqual([]);
  });

  it("collects every alias declared across terraform blocks", () => {
    const parsed = {
      terraform: [
        {
          required_providers: [
            {
              aws: {
                source: "hashicorp/aws",
                configuration_aliases: [
                  "${aws.global_region}",
                  "${aws.secondary}",
                ],
              },
              random: { source: "hashicorp/random" },
            },
          ],
        },
        {
          required_providers: [
            {
              awsx: {
                source: "hashicorp/aws",
                configuration_aliases: ["${awsx.tertiary}"],
              },
            },
          ],
        },
      ],
    };

    expect(collectModuleProviderAliases(parsed)).toEqual([
      { localName: "aws", alias: "global_region", source: "hashicorp/aws" },
      { localName: "aws", alias: "secondary", source: "hashicorp/aws" },
      { localName: "awsx", alias: "tertiary", source: "hashicorp/aws" },
    ]);
  });

  it("deduplicates aliases declared in more than one file", () => {
    const declaration = {
      aws: {
        source: "hashicorp/aws",
        configuration_aliases: ["${aws.global_region}"],
      },
    };
    const parsed = {
      terraform: [{ required_providers: [declaration, declaration] }],
    };

    expect(collectModuleProviderAliases(parsed)).toEqual([
      { localName: "aws", alias: "global_region", source: "hashicorp/aws" },
    ]);
  });

  it("keeps aliases of providers declared without a source", () => {
    const parsed = {
      terraform: {
        required_providers: {
          aws: { configuration_aliases: ["${aws.other}"] },
        },
      },
    };

    expect(collectModuleProviderAliases(parsed)).toEqual([
      { localName: "aws", alias: "other", source: undefined },
    ]);
  });

  it("reads the plain references a .tf.json module declares", () => {
    // hcl2json only wraps HCL expressions in an interpolation; JSON syntax
    // carries the reference as-is, and its blocks come through unwrapped
    const parsed = {
      terraform: {
        required_providers: {
          null: {
            source: "hashicorp/null",
            configuration_aliases: ["null.extra"],
          },
        },
      },
    };

    expect(collectModuleProviderAliases(parsed)).toEqual([
      { localName: "null", alias: "extra", source: "hashicorp/null" },
    ]);
  });

  it("ignores entries that are not provider configuration references", () => {
    const parsed = {
      terraform: {
        required_providers: {
          aws: { configuration_aliases: ["${aws}", "${var.not_an_alias.x}"] },
        },
      },
    };

    expect(collectModuleProviderAliases(parsed)).toEqual([]);
  });
});

describe("applyModuleProviderAliases", () => {
  const configWithModule = (): TerraformConfig => ({
    terraform: {},
    module: { my_module: { source: "./mod" } },
  });

  it("declares the aliased providers and passes them to the module", () => {
    const config = applyModuleProviderAliases(configWithModule(), "my_module", [
      { localName: "aws", alias: "global_region", source: "hashicorp/aws" },
      { localName: "aws", alias: "secondary", source: "hashicorp/aws" },
    ]);

    expect(config).toEqual({
      terraform: { required_providers: { aws: { source: "hashicorp/aws" } } },
      provider: { aws: [{ alias: "global_region" }, { alias: "secondary" }] },
      module: {
        my_module: {
          source: "./mod",
          providers: {
            "aws.global_region": "aws.global_region",
            "aws.secondary": "aws.secondary",
          },
        },
      },
    });
  });

  it("omits required_providers for aliases without a declared source", () => {
    const config = applyModuleProviderAliases(configWithModule(), "my_module", [
      { localName: "aws", alias: "other" },
    ]);

    expect(config.terraform.required_providers).toBeUndefined();
    expect(config.provider).toEqual({ aws: [{ alias: "other" }] });
  });

  it("leaves the config untouched when there are no aliases", () => {
    expect(
      applyModuleProviderAliases(configWithModule(), "my_module", []),
    ).toEqual(configWithModule());
  });

  it("leaves the config untouched when the module call is unknown", () => {
    expect(
      applyModuleProviderAliases(configWithModule(), "other_module", [
        { localName: "aws", alias: "global_region" },
      ]),
    ).toEqual(configWithModule());
  });
});

describe("packageSubdir", () => {
  it.each([
    ["terraform-aws-modules/iam/aws", undefined],
    [
      "terraform-aws-modules/iam/aws//modules/iam-account",
      "modules/iam-account",
    ],
    ["git::https://github.com/org/repo.git//sub?ref=v1.2.3", "sub"],
    ["git::ssh://git@github.com/org/repo.git", undefined],
    ["./local/module", undefined],
  ])("splits %s", (source, expected) => {
    expect(packageSubdir(source as string)).toEqual(expected);
  });
});

describe("fetchedModuleDir", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "fetched-module-dir-"));
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  function writeManifest(modules: { Key: string; Dir: string }[]) {
    const dir = path.join(workdir, ".terraform", "modules");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "modules.json"),
      JSON.stringify({ Modules: modules }),
    );
  }

  it("prefers the directory recorded in the module manifest", () => {
    writeManifest([
      { Key: "", Dir: "." },
      { Key: "my_module", Dir: ".terraform/modules/my_module/modules/sub" },
    ]);

    expect(
      fetchedModuleDir(workdir, "my_module", "org/name/aws//modules/sub"),
    ).toEqual(
      path.join(
        workdir,
        ".terraform",
        "modules",
        "my_module",
        "modules",
        "sub",
      ),
    );
  });

  it("falls back to the install path when the manifest was not written", () => {
    expect(
      fetchedModuleDir(workdir, "my_module", "org/name/aws//modules/sub"),
    ).toEqual(
      path.join(
        workdir,
        ".terraform",
        "modules",
        "my_module",
        "modules",
        "sub",
      ),
    );
  });

  it("falls back to the install path when the manifest lacks the module", () => {
    writeManifest([{ Key: "", Dir: "." }]);

    expect(fetchedModuleDir(workdir, "my_module", "org/name/aws")).toEqual(
      path.join(workdir, ".terraform", "modules", "my_module"),
    );
  });

  it("reads local modules where they are", () => {
    expect(
      fetchedModuleDir(workdir, "my_module", "../mod", "/abs/path/to/mod"),
    ).toEqual("/abs/path/to/mod");
  });
});
