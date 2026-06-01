// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { v4 as uuidv4 } from "uuid";
import * as os from "os";
import ciInfo from "ci-info";
import { logger } from "./logging";
import * as path from "path";
import * as fs from "fs-extra";
import { DISPLAY_VERSION } from "./version";

const MAX_REQUEST_BODY_SIZE = 8192;

function homeDir() {
  return process.env.CDKTF_HOME
    ? path.resolve(process.env.CDKTF_HOME)
    : path.join(
        (os.userInfo().homedir ?? os.homedir()).trim() || "/",
        ".cdktf",
      );
}

export interface ReportParams {
  dateTime?: Date;
  arch?: string;
  os?: string;
  payload: Record<string, any>;
  product: string;
  runID?: string;
  version?: string;
  command?: string;
  language?: string;
  userId?: string;
  ci?: string;
  projectId?: string;
}

export async function sendTelemetry(
  command: string,
  payload: Record<string, any>,
) {
  const reportParams: ReportParams = {
    command,
    product: "cdktn",
    version: `${DISPLAY_VERSION}`,
    dateTime: new Date(),
    language: payload.language,
    payload,
  };

  try {
    await ReportRequest(reportParams);
  } catch (err) {
    logger.error(`Could not send telemetry data: ${err}`);
  }
}

function getId<K extends string>(
  filePath: string,
  key: K,
  forceCreation = false,
  explanatoryComment?: string,
): string {
  const _uuid = uuidv4(); // create a new UUID in case we don't find one

  let jsonFile: { [P in K]: string };
  try {
    jsonFile = JSON.parse(fs.readFileSync(filePath, "utf-8")); // we found the file
  } catch {
    // we found no file, create one if we're forcing a creation
    if (forceCreation) {
      const _idFile = {} as Record<string, string>; // compose JSON id file in case we don't find one
      if (explanatoryComment) {
        _idFile["//"] = explanatoryComment.replace(/\n/g, " ");
      }
      _idFile[key] = _uuid;
      fs.ensureDirSync(path.dirname(filePath));
      fs.writeFileSync(filePath, JSON.stringify(_idFile, null, 2));
    }
    return _uuid;
  }

  if (jsonFile[key]) {
    return jsonFile[key]; // we found an id
  } else {
    // we found no id, we add it to the file for future use
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...jsonFile, [key]: _uuid }, null, 2),
    );
    return _uuid;
  }
}

export function getProjectId(projectPath = process.cwd()): string {
  return getId(path.resolve(projectPath, "cdktf.json"), "projectId");
}

export function getUserId(): string {
  return getId(
    path.resolve(homeDir(), "config.json"),
    "userId",
    true,
    `This signature is a randomly generated UUID used to anonymously differentiate users in telemetry data order to inform product direction.
This signature is random, it is not based on any personally identifiable information.
To create a new signature, you can simply delete this file at any time.
See https://cdktn.io/docs/telemetry for more
information on how to disable it.`,
  );
}

export async function ReportRequest(reportParams: ReportParams): Promise<void> {
  // we won't report when checkpoint is disabled.
  // Check at runtime (not import time) to allow tests to modify the env var
  if (process.env.CHECKPOINT_DISABLE) {
    return;
  }

  if (!reportParams.runID) {
    reportParams.runID = uuidv4();
  }

  if (!reportParams.dateTime) {
    reportParams.dateTime = new Date();
  }

  if (!reportParams.arch) {
    reportParams.arch = os.arch();
  }

  if (!reportParams.os) {
    reportParams.os = os.platform();
  }

  const ci: string | false = ciInfo.isCI ? ciInfo.name || "unknown" : false;
  if (!reportParams.userId && !ci) {
    reportParams.userId = getUserId();
  }

  if (ci) {
    reportParams.ci = ci;
  }

  reportParams.projectId = reportParams.projectId || getProjectId();

  const postData = JSON.stringify(reportParams);

  if (postData.length > MAX_REQUEST_BODY_SIZE) {
    logger.warn(
      `Skipped sending telemetry as the request body size was ${postData.length} bytes. The limit is ${MAX_REQUEST_BODY_SIZE} bytes`,
    );
    return;
  }

  // In the future, we will actually send telemetry here.
}
