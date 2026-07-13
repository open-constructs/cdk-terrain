// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as z from "zod";

const remote = z
  .object({
    organization: z.string(),
    hostname: z.string().optional(),
    token: z.string().optional(),
    workspaces: z
      .object({
        name: z.string().optional(),
        prefix: z.string().optional(),
      })
      .partial(),
  })
  .partial();

export const terraformJsonSchema = z
  .object({
    "//": z
      .object({
        metadata: z
          .object({
            version: z.string(),
            stackName: z.string(),
            backend: z.string(),
          })
          .partial()
          .loose(),
        outputs: z.record(z.string(), z.any()),
      })
      .partial()
      .loose(),
    terraform: z
      .object({
        backend: z
          .object({
            // All other backends are here as well, but we don't read them right now
            remote,
          })
          .partial()
          .loose(),
        cloud: z
          .object({
            organization: z.string(),
            hostname: z.string().optional(),
            token: z.string().optional(),
            workspaces: z.union([
              z.object({ name: z.string() }),
              z.object({ tags: z.array(z.string()) }),
            ]),
          })
          .partial()
          .loose(),
        required_providers: z.record(
          z.string(),
          z.object({ source: z.string(), version: z.string() }).loose(),
        ),
        required_version: z.string(),
      })
      .partial(),
    data: z.record(z.string(), z.any()),
    provider: z.record(z.string(), z.any()),
    resource: z.record(z.string(), z.any()),
  })
  .partial()
  .loose();

export type TerraformStack = z.infer<typeof terraformJsonSchema>;
export type TerraformJsonConfigBackendRemote = z.infer<typeof remote>;
