/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import * as hcl2cdk from "@cdktn/hcl2cdk";
import { CdktfConfig } from "./cdktf-config";
import { TerraformProviderConstraint } from "@cdktn/provider-generator";
import { readSchema } from "@cdktn/provider-schema";
import {
  Errors,
  LANGUAGES,
  ConstructsMakerProviderTarget,
} from "@cdktn/commons";

export async function convertConfigurationFile(
  configuration: string,
  stackWorkingDirectory: string,
) {
  const cfg = CdktfConfig.read(stackWorkingDirectory);
  const targets = cfg.terraformProviders.map((constraint) =>
    ConstructsMakerProviderTarget.from(
      new TerraformProviderConstraint(constraint),
      LANGUAGES[0],
    ),
  );
  const { providerSchema } = await readSchema(targets);
  if (!providerSchema) {
    throw Errors.Internal("Could not fetch provider schema");
  }

  const { all } = await hcl2cdk.convert(configuration, {
    providerSchema,
    language: cfg.language,
    codeContainer: "constructs.Construct",
  });

  return all;
}
