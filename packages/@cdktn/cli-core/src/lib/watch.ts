// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import path from "path";
import {
  CdktfProject,
  CdktfProjectOptions,
  MutationOptions,
} from "./cdktf-project";
import * as fs from "fs";
import * as chokidar from "chokidar";
import { logger, Errors, sendTelemetry } from "@cdktn/commons";
import { CdktfStack } from "./cdktf-stack";

// In this very first iteration we will find out which files to watch by asking the user to provide the files
// We default to something reasonable per language and write it into the cdkt.json file
// Mid-Term we might want to add a WatchFile / WatchDir construct that we can use (e.g. in assets) and that a user can use to specify their watch behaviour
// See https://github.com/hashicorp/terraform-cdk/issues/1668
function getOrWriteDefaultWatchConfig(projectPath = process.cwd()) {
  const cdktfJsonPath = path.resolve(projectPath, "cdktf.json");
  logger.debug(`Getting files to watch from cdktf.json at ${cdktfJsonPath}`);

  let cdktfJson;
  try {
    cdktfJson = JSON.parse(fs.readFileSync(cdktfJsonPath, "utf-8"));
  } catch (err: any) {
    throw Errors.Internal(
      `Could not find cdktf.json file in ${projectPath}`,
      err,
    );
  }

  if (cdktfJson.watchPattern) {
    logger.debug(`Found watchPattern in cdktf.json: ${cdktfJson.watchPattern}`);
    return cdktfJson.watchPattern;
  }
  const language:
    "typescript" | "python" | "java" | "csharp" | "go" | undefined =
    cdktfJson.language;

  if (!language) {
    throw Errors.Usage(
      `No language specified in cdktf.json, please either specify a language or watchPattern to use the watch command`,
    );
  }

  const defaultWatchPattern = {
    typescript: ["./**/*.ts"],
    python: ["./**/*.py"],
    java: ["src/**/*.java"],
    csharp: ["./**/*.cs"],
    go: ["./**/*.go"],
  }[language];

  fs.writeFileSync(
    cdktfJsonPath,
    JSON.stringify(
      { ...cdktfJson, watchPattern: defaultWatchPattern },
      null,
      2,
    ),
  );
  logger.debug(`Write default watchPattern for ${language} in cdktf.json.`);

  return defaultWatchPattern;
}

const projectStatus = (project?: CdktfProject) => {
  if (!project?.stacksToRun.length) {
    return {
      inProgress: [],
      finished: [],
      pending: [],
    };
  }

  const inProgress = project.stacksToRun.filter((s) => s.isRunning);
  const finished = project.stacksToRun.filter((s) => s.isDone);
  const pending = project.stacksToRun.filter((s) => s.isPending);
  return { inProgress, finished, pending };
};

export type State =
  | {
      type: "waiting";
    }
  | {
      type: "running";
      nextRunQueued: boolean;
      currentRun: Promise<void>;
      inProgress: CdktfStack[];
      finished: CdktfStack[];
      pending: CdktfStack[];
    }
  | { type: "stopped" };

export async function watch(
  projectOptions: CdktfProjectOptions,
  mutationOptions: MutationOptions,
  abortSignal: AbortSignal,
  onStateChange: (newState: State) => void,
) {
  const patterns = getOrWriteDefaultWatchConfig();
  const watcher = chokidar.watch(patterns, {
    ignoreInitial: true,
  });
  let state: State = { type: "waiting" };
  const changeState = (newState: State) => {
    state = newState;
    onStateChange(state);
  };

  let resolveSession!: (outcome: Promise<void> | void) => void;
  const session = new Promise<void>((resolve) => {
    resolveSession = resolve;
  });

  // Idempotent: a failing run and an abort can both ask for the end.
  function endSession(failed?: { error: unknown }) {
    if (state.type === "stopped") {
      return;
    }
    const inFlight = state.type === "running" ? state.currentRun : undefined;
    changeState({ type: "stopped" });
    resolveSession(
      watcher
        .close()
        .then(() => (failed ? Promise.reject(failed.error) : inFlight)),
    );
  }

  async function deployOnce() {
    logger.debug("Running cdktn deploy");
    const project = new CdktfProject({
      synthOrigin: "watch",
      ...projectOptions,
      onLog: (log) => {
        if (projectOptions.onLog) {
          projectOptions.onLog(log);
        }
        if (state.type === "running") {
          changeState({ ...state, ...projectStatus(project) });
        }
      },
    });
    const abort = () => project.hardAbort();
    abortSignal.addEventListener("abort", abort);
    try {
      await project.deploy(mutationOptions);
    } finally {
      abortSignal.removeEventListener("abort", abort);
    }
    logger.debug("cdktn deploy finished");
    return project;
  }

  // One promise covers a run and every re-run queued behind it.
  async function runUntilIdle() {
    let rerun: boolean;
    do {
      const project = await deployOnce();
      if (state.type !== "running") {
        return;
      }
      rerun = state.nextRunQueued;
      changeState({
        ...state,
        nextRunQueued: false,
        ...projectStatus(project),
      });
    } while (rerun);
    logger.debug("Nothing queued, waiting for changes");
    changeState({ type: "waiting" });
  }

  // The only place a run starts, so every run has its failure observed.
  // hardAbort rejects the in-flight deploy after the abort has already
  // stopped the session, which makes that rejection a no-op here.
  function startRun() {
    const currentRun = runUntilIdle().catch((error) => endSession({ error }));
    changeState({
      type: "running",
      nextRunQueued: false,
      currentRun,
      ...projectStatus(),
    });
  }

  // Without a failure the session ends only on abort: the CLI exits as soon
  // as its handler returns, so resolving earlier would end `cdktn watch`
  // after the first run.
  abortSignal.addEventListener("abort", () => {
    logger.debug("Abort signal received, stopping watch");
    endSession();
  });

  const onFileChange = () => {
    if (state.type === "stopped") {
      return;
    }

    if (state.type === "running") {
      changeState({ ...state, nextRunQueued: true });
      return;
    }

    startRun();
  };

  watcher.on("all", onFileChange);
  // initially run once
  onFileChange();

  // Awaited together so a run failing during the report is still observed.
  await Promise.all([sendTelemetry("watch", { event: "start" }), session]);
}
