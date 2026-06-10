// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { v4 as uuidv4 } from "uuid";
import * as os from "os";
import * as path from "path";
import * as fs from "fs-extra";

function homeDir() {
  return process.env.CDKTF_HOME
    ? path.resolve(process.env.CDKTF_HOME)
    : path.join(
        (os.userInfo().homedir ?? os.homedir()).trim() || "/",
        ".cdktf",
      );
}

function getId(
  filePath: string,
  key: string,
  forceCreation = false,
  explanatoryComment?: string,
): string {
  const _uuid = uuidv4(); // create a new UUID in case we don't find one

  let jsonFile;
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
