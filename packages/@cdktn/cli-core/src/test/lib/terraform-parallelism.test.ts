/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import path from "path";
import * as fs from "fs-extra";
import { EventEmitter } from "events";
import { CdktnProject, init } from "../../lib/index";
import { spawn } from "cross-spawn";
import { exec } from "@cdktn/commons";
import { createTmpHelper, describeIfDistExists } from "../test-helpers";

const tmp = createTmpHelper();

jest.mock("@cdktn/commons", () => {
  const originalModule = jest.requireActual("@cdktn/commons");

  return {
    __esmodule: true,
    ...originalModule,
    // Stub every spawned command. The tests assert on `cross-spawn` calls (terraform apply/plan/destroy parallelism
    // flags); they don't need real `exec` output.
    exec: jest.fn().mockImplementation(async () => JSON.stringify({})),
  };
});

jest.mock("cross-spawn", () => {
  return {
    spawn: jest.fn().mockImplementation((_file, _args) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stdin: { write: () => void };
        kill: () => void;
      };

      child.stdout = new EventEmitter();
      child.stdin = {
        write: () => undefined,
      };
      child.kill = () => undefined;

      setImmediate(() => child.emit("close", 0));

      return child;
    }),
  };
});

let inNewWorkingDirectory: () => {
  workingDirectory: string;
  outDir: string;
};

jest.setTimeout(120_000);
const projectName = `cdktf-api-test`;

const stackWithName = (name: string) => {
  return {
    name,
    constructPath: name,
    workingDirectory: `cdktf.out/stacks/${name}`,
    synthesizedStackPath: `stacks/${name}/cdk.tf.json`,
    stackMetadataPath: `stacks/${name}/metadata.json`,
    annotations: [],
    dependencies: [],
    content: JSON.stringify({
      name,
      backend: {
        type: "local",
        config: {
          path: `${name}.tfstate`,
        },
      },
      config: {
        required_providers: {
          null: {
            source: "hashicorp/null",
            version: "3.1.0",
          },
        },
      },
      terraformVersion: "1.6.5",
      variables: {},
      outputs: {},
      resources: [
        {
          name,
          type: "null_resource",
          config: {
            triggers: {
              foo: "bar",
            },
          },
        },
      ],
    }),
  };
};

describeIfDistExists(__dirname)("terraform parallelism", () => {
  beforeAll(async () => {
    const workingDirectory = tmp("cdktf.");
    await init({
      destination: workingDirectory,
      templatePath: path.join(__dirname, "../../../templates/typescript"),
      projectId: "test",
      projectInfo: {
        Description: projectName,
        Name: projectName,
      },
      sendCrashReports: false,
      dist: path.join(__dirname, "../../../../../../dist"),
    });

    fs.copyFileSync(
      path.resolve(__dirname, "fixtures/default/main.ts.fixture"),
      path.resolve(workingDirectory, "main.ts"),
    );
    fs.copyFileSync(
      path.resolve(__dirname, "fixtures/default/cdktf.json"),
      path.resolve(workingDirectory, "cdktf.json"),
    );

    inNewWorkingDirectory = function inNewWorkingDirectory() {
      const wd = tmp("cdktf.");
      const outDir = path.resolve(wd, "out");

      fs.copySync(workingDirectory, wd);

      return {
        workingDirectory: wd,
        outDir,
      };
    };
  }, 120_000);

  beforeEach(() => {
    (exec as jest.Mock).mockClear();
    (spawn as jest.Mock).mockClear();
  });

  afterAll(() => {
    jest.resetModules();
  });

  describe("terraform parallelism flag in deploy", () => {
    it("passes the terraform parallelism flag to terraform", async () => {
      const events: any[] = [];
      const cdktnProject = new CdktnProject({
        synthCommand: "npx ts-node main.ts",
        ...inNewWorkingDirectory(),
        onUpdate: (event) => {
          events.push(event);
          if (event.type === "waiting for approval") {
            event.approve();
          }
        },
      });

      cdktnProject.synth = jest.fn().mockImplementation(async () => {
        return [
          stackWithName("first"),
          stackWithName("second"),
          stackWithName("third"),
          stackWithName("fourth"),
        ];
      });

      await cdktnProject.deploy({
        stackNames: ["first"],
        autoApprove: true,
        parallelism: 1,
        terraformParallelism: 1,
      });

      const spawnCalls = (spawn as jest.Mock).mock.calls;
      const applyCall = spawnCalls.find((call) => call[1][0] === "apply");
      expect(applyCall[1]).toContain("-parallelism=1");
    });

    it("ignores the terraform parallelism flag if negative", async () => {
      const events: any[] = [];
      const cdktnProject = new CdktnProject({
        synthCommand: "npx ts-node ./main.ts",
        ...inNewWorkingDirectory(),
        onUpdate: (event) => {
          events.push(event);
          if (event.type === "waiting for approval") {
            event.approve();
          }
        },
      });

      cdktnProject.synth = jest.fn().mockImplementation(async () => {
        return [
          stackWithName("first"),
          stackWithName("second"),
          stackWithName("third"),
          stackWithName("fourth"),
        ];
      });

      await cdktnProject.deploy({
        stackNames: ["first"],
        autoApprove: true,
        parallelism: 1,
        terraformParallelism: -1,
      });

      const spawnCalls = (spawn as jest.Mock).mock.calls;
      const applyCall = spawnCalls.find((call) => call[1][0] === "apply");
      expect(applyCall[1]).not.toContain("-parallelism=1");
    });
  });

  describe("terraform parallelism flag in destroy", () => {
    it("passes the terraform parallelism flag to terraform", async () => {
      const events: any[] = [];
      const cdktnProject = new CdktnProject({
        synthCommand: "npx ts-node ./main.ts",
        ...inNewWorkingDirectory(),
        onUpdate: (event) => {
          events.push(event);
        },
      });

      cdktnProject.synth = jest.fn().mockImplementation(async () => {
        return [
          stackWithName("first"),
          stackWithName("second"),
          stackWithName("third"),
          stackWithName("fourth"),
        ];
      });

      await cdktnProject.destroy({
        stackNames: ["second"],
        autoApprove: true,
        parallelism: 1,
        terraformParallelism: 1,
      });

      const spawnCalls = (spawn as jest.Mock).mock.calls;
      const destroyCall = spawnCalls.find((call) => call[1][0] === "destroy");
      expect(destroyCall[1]).toContain("-parallelism=1");
    });

    it("doesn't pass the terraform parallelism flag if negative", async () => {
      const events: any[] = [];
      const cdktnProject = new CdktnProject({
        synthCommand: "npx ts-node ./main.ts",
        ...inNewWorkingDirectory(),
        onUpdate: (event) => {
          events.push(event);
        },
      });

      cdktnProject.synth = jest.fn().mockImplementation(async () => {
        return [
          stackWithName("first"),
          stackWithName("second"),
          stackWithName("third"),
          stackWithName("fourth"),
        ];
      });

      await cdktnProject.destroy({
        stackNames: ["second"],
        autoApprove: true,
        parallelism: 1,
        terraformParallelism: -1,
      });

      const spawnCalls = (spawn as jest.Mock).mock.calls;
      const destroyCall = spawnCalls.find((call) => call[1][0] === "destroy");
      expect(destroyCall[1]).not.toContain("-parallelism=-1");
    });
  });

  describe("terraform parallelism flag in diff", () => {
    it("passes the terraform parallelism flag to terraform", async () => {
      const events: any[] = [];
      const cdktnProject = new CdktnProject({
        synthCommand: "npx ts-node main.ts",
        ...inNewWorkingDirectory(),
        onUpdate: (event) => {
          events.push(event);
          if (event.type === "waiting for approval") {
            event.approve();
          }
        },
      });

      cdktnProject.synth = jest.fn().mockImplementation(async () => {
        return [
          stackWithName("first"),
          stackWithName("second"),
          stackWithName("third"),
          stackWithName("fourth"),
        ];
      });

      await cdktnProject.diff({
        stackName: "first",
        terraformParallelism: 1,
      });

      const execCalls = (exec as jest.Mock).mock.calls;
      const planCall = execCalls.find((call) => call[1][0] === "plan");
      expect(planCall[1]).toContain("-parallelism=1");
    });

    it("ignores the terraform parallelism flag if negative", async () => {
      const events: any[] = [];
      const cdktnProject = new CdktnProject({
        synthCommand: "npx ts-node ./main.ts",
        ...inNewWorkingDirectory(),
        onUpdate: (event) => {
          events.push(event);
          if (event.type === "waiting for approval") {
            event.approve();
          }
        },
      });

      cdktnProject.synth = jest.fn().mockImplementation(async () => {
        return [
          stackWithName("first"),
          stackWithName("second"),
          stackWithName("third"),
          stackWithName("fourth"),
        ];
      });

      await cdktnProject.diff({
        stackName: "first",
        terraformParallelism: -1,
      });

      const execCalls = (exec as jest.Mock).mock.calls;
      const planCall = execCalls.find((call) => call[1][0] === "plan");
      expect(planCall[1]).not.toContain("-parallelism=-1");
    });
  });
});
