// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import Ajv from "ajv";
import { sscaff } from "sscaff";
import { substitute } from "sscaff/lib/substitute";
import { init, templatesDir } from "../../lib/init";

// The real template hooks install dependencies, so sscaff only lays down the cdktf.json that init reads back.
jest.mock("sscaff", () => ({ sscaff: jest.fn() }));

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

describe("cdktf.json schema", () => {
  const workspaceRoot = path.resolve(__dirname, "../../../../../..");
  const validate = new Ajv({ allErrors: true }).compile(
    fs.readJsonSync(path.join(workspaceRoot, "cdktf.schema.json")),
  );
  // Variants such as typescript-pnpm carry no cdktf.json; they ship their base's files.
  const baseTemplates = fs
    .readdirSync(templatesDir)
    .filter((name) =>
      fs.existsSync(path.join(templatesDir, name, "cdktf.json")),
    );
  let destination: string;

  beforeEach(() => {
    destination = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-init-"));
    // Renders only cdktf.json with init's real variables; the template hooks would install dependencies.
    (sscaff as jest.Mock).mockImplementation(async (src, target, variables) => {
      fs.writeFileSync(
        path.join(target, "cdktf.json"),
        substitute(
          fs.readFileSync(path.join(src, "cdktf.json"), "utf8"),
          variables,
        ),
      );
    });
  });

  afterEach(() => {
    fs.removeSync(destination);
  });

  it.each(baseTemplates)(
    "accepts the cdktf.json init writes for %s",
    async (template) => {
      await init({
        cdktnVersion: "1.2.3",
        destination,
        projectId: "test",
        projectInfo: { Name: "test", Description: "test" },
        templatePath: path.join(templatesDir, template),
        sendCrashReports: false,
        sendUsageTelemetry: true,
        silent: true,
      });
      const config = fs.readJsonSync(path.join(destination, "cdktf.json"));

      expect(config.$schema).toBe(
        "https://cdn.jsdelivr.net/gh/open-constructs/cdk-terrain@v1.2.3/cdktf.schema.json",
      );
      expect(validate(config) ? [] : validate.errors).toEqual([]);
    },
  );

  // Each mirrors a value the CLI rejects or ignores at runtime.
  it.each([
    { language: "rust" },
    { targetVersions: { terrafrom: ">=1.5.7" } },
    { targetVersions: {} },
    { sendCrashReports: "yes" },
    { terraformProviders: [{ source: "hashicorp/aws" }] },
  ])("rejects %j", (config) => {
    expect(validate(config)).toBe(false);
  });
});
