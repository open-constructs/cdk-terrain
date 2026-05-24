/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */
import type { Config } from "jest";
import { getJestProjectsAsync } from "@nx/jest";

export default async (): Promise<Config> => ({
  projects: await getJestProjectsAsync(),
});
