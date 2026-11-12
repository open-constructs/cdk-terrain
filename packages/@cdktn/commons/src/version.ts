// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { version } from "../package.json";

export const DISPLAY_VERSION = `${versionNumber()}`;

function versionNumber(): string {
  return version.replace(/\+[0-9a-f]+$/, "");
}
