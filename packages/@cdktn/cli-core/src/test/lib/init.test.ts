// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { sscaff } from "sscaff";
import { InitTarget } from "@cdktn/commons";
import { init, templatesDir } from "../../lib/init";
import { providerAdd } from "../../lib/provider-add";

// The real template hooks install dependencies, so sscaff only lays down the cdktf.json that init reads back.
jest.mock("sscaff", () => ({ sscaff: jest.fn() }));
jest.mock("../../lib/provider-add", () => ({ providerAdd: jest.fn() }));

const docsNote = expect.stringMatching(/https:\/\/cdktn\.io\/docs\//);

describe(".mcp.json on init", () => {
  let destination: string;
  let log: jest.SpyInstance;

  const run = (templatePath: string, silent = false) =>
    init({
      cdktnVersion: "1.0.0",
      destination,
      projectId: "test",
      projectInfo: { Name: "test", Description: "test" },
      templatePath,
      sendCrashReports: false,
      sendUsageTelemetry: false,
      silent,
    });

  beforeEach(() => {
    destination = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-init-"));
    (sscaff as jest.Mock).mockImplementation(async (_src, target) => {
      fs.writeFileSync(
        path.join(target, "cdktf.json"),
        JSON.stringify({ language: "typescript", app: "npx tsx main.ts" }),
      );
    });
    log = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    log.mockRestore();
    fs.removeSync(destination);
  });

  it.each(["typescript", "typescript-pnpm"])(
    "writes the docs server config for the built-in %s template",
    async (template) => {
      await run(path.join(templatesDir, template));

      expect(
        fs.readFileSync(path.join(destination, ".mcp.json"), "utf8"),
      ).toContain("https://cdktn.io/docs/mcp");
      expect(log).not.toHaveBeenCalledWith(docsNote);
    },
  );

  it("leaves an existing config byte-identical and says how to add the server", async () => {
    const existing = Buffer.from('{ "mcpServers": { "other": {} } }');
    fs.writeFileSync(path.join(destination, ".mcp.json"), existing);

    await run(path.join(templatesDir, "typescript"));

    expect(fs.readFileSync(path.join(destination, ".mcp.json"))).toEqual(
      existing,
    );
    expect(log).toHaveBeenCalledWith(docsNote);
  });

  it("prints no note when silent", async () => {
    fs.writeFileSync(path.join(destination, ".mcp.json"), "{}");

    await run(path.join(templatesDir, "typescript"), true);

    expect(log).not.toHaveBeenCalled();
  });

  it("leaves .mcp.json to a remote template", async () => {
    const existing = Buffer.from("{}");
    fs.writeFileSync(path.join(destination, ".mcp.json"), existing);
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-remote-"));
    try {
      await run(path.join(remote, "typescript"));
    } finally {
      fs.removeSync(remote);
    }

    expect(fs.readFileSync(path.join(destination, ".mcp.json"))).toEqual(
      existing,
    );
    expect(log).not.toHaveBeenCalledWith(docsNote);
  });
});

describe("targetVersions on init", () => {
  let destination: string;
  const template = { terraform: ">=1.9.0", opentofu: ">=1.9.0" };
  const readTargets = () =>
    fs.readJsonSync(path.join(destination, "cdktf.json")).targetVersions;

  const run = (target?: InitTarget) =>
    init({
      cdktnVersion: "1.0.0",
      destination,
      projectId: "test",
      projectInfo: { Name: "test", Description: "test" },
      templatePath: path.join(templatesDir, "typescript"),
      sendCrashReports: false,
      sendUsageTelemetry: false,
      silent: true,
      providers: ["random"],
      target,
    });

  beforeEach(() => {
    destination = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-init-"));
    (sscaff as jest.Mock).mockImplementation(async (_src, target) => {
      fs.writeJsonSync(path.join(target, "cdktf.json"), {
        language: "typescript",
        app: "npx tsx main.ts",
        targetVersions: template,
      });
    });
  });

  afterEach(() => fs.removeSync(destination));

  // provider add picks its registry from targetVersions
  it.each([
    ["terraform", { terraform: ">=1.5.7" }],
    ["opentofu", { opentofu: ">=1.6.0" }],
    ["both", { terraform: ">=1.5.7", opentofu: ">=1.6.0" }],
  ] as const)(
    "writes the %s targets before adding providers",
    async (target, expected) => {
      (providerAdd as jest.Mock).mockImplementation(async () => {
        expect(readTargets()).toEqual(expected);
        return false;
      });

      await run(target);

      expect(providerAdd).toHaveBeenCalled();
    },
  );

  it("keeps the template's targets without a target", async () => {
    (providerAdd as jest.Mock).mockResolvedValue(false);

    await run();

    expect(readTargets()).toEqual(template);
  });
});
