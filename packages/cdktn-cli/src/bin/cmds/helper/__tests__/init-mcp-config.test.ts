// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

// Scaffolding is stubbed with what sscaff does to `.mcp.json`: overwrite it with the template's copy.
const mockInitLib = jest.fn();
jest.mock("@cdktn/cli-core", () => ({
  ...jest.requireActual("@cdktn/cli-core"),
  init: (...args: unknown[]) => mockInitLib(...args),
}));

jest.mock("../terraform-check", () => ({
  getTerraformVersion: jest.fn().mockResolvedValue(undefined),
  terraformCheck: jest.fn().mockResolvedValue(undefined),
}));

import { templatesDir } from "@cdktn/cli-core";
import { runInit } from "../init";

const cdktnServer = { type: "http", url: "https://cdktn.io/docs/mcp" };
const githubServer = {
  type: "http",
  url: "https://api.githubcopilot.com/mcp/",
};

describe("runInit with an existing .mcp.json", () => {
  let destination: string;
  let mcpFile: string;

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
      enableUsageTelemetry: false,
      providers: [],
    });

  beforeEach(() => {
    destination = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-init-mcp-"));
    mcpFile = path.join(destination, ".mcp.json");
    mockInitLib.mockImplementation(async () => {
      fs.copySync(
        path.join(templatesDir, "typescript", "{{}}.mcp.json"),
        mcpFile,
      );
      fs.writeJsonSync(path.join(destination, "cdktf.json"), {
        language: "typescript",
        app: "npx ts-node main.ts",
      });
      return false;
    });
  });

  afterEach(() => {
    fs.removeSync(destination);
  });

  it("writes the template's config when there is none", async () => {
    await init();

    expect(fs.readJsonSync(mcpFile)).toEqual({
      mcpServers: { cdktn: cdktnServer },
    });
  });

  it("adds the cdktn server next to the user's servers", async () => {
    fs.writeJsonSync(mcpFile, { mcpServers: { github: githubServer } });

    await init();

    expect(fs.readJsonSync(mcpFile)).toEqual({
      mcpServers: { github: githubServer, cdktn: cdktnServer },
    });
  });

  it("keeps the user's own cdktn entry", async () => {
    const original = JSON.stringify({
      mcpServers: { cdktn: { type: "http", url: "http://localhost:3000" } },
    });
    fs.writeFileSync(mcpFile, original);

    await init();

    expect(fs.readFileSync(mcpFile, "utf8")).toBe(original);
  });

  it("leaves a config it cannot parse untouched", async () => {
    const original = '{ "mcpServers": { // comment\n} }';
    fs.writeFileSync(mcpFile, original);

    await init();

    expect(fs.readFileSync(mcpFile, "utf8")).toBe(original);
  });
});
