// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

import * as path from "path";
import stableStringify from "safe-stable-stringify";
import {
  TerraformModuleConstraint,
  TerraformProviderConstraint,
  ConstructsMakerModuleTarget,
  ConstructsMakerProviderTarget,
  Language,
  ProviderSchema,
} from "@cdktn/commons";
import {
  readModuleSchema,
  readProviderSchema,
  sanitizeProviderSchema,
} from "../provider-schema";

function sanitizeJson(value: any) {
  value["format_version"] = "STUBBED VERSION";
  // cli_name/cli_version stamp whatever binary fetched the schema and vary
  // by environment
  if ("cli_name" in value) value["cli_name"] = "STUBBED CLI";
  if ("cli_version" in value) value["cli_version"] = "STUBBED VERSION";
  return stableStringify(value, null, 2);
}

describe("readSchema", () => {
  it("generates a single provider schema", async () => {
    const provider = new TerraformProviderConstraint("hashicorp/null@3.1.0");
    const target = new ConstructsMakerProviderTarget(
      provider,
      Language.TYPESCRIPT,
    );
    const result = await readProviderSchema(target);
    expect(sanitizeJson(result)).toMatchSnapshot();
  }, 120000);

  it("generates a single module schema", async () => {
    const module = new TerraformModuleConstraint(
      "terraform-aws-modules/iam/aws//modules/iam-account@3.12.0",
    );
    const target = new ConstructsMakerModuleTarget(module, Language.TYPESCRIPT);
    const result = await readModuleSchema(target);
    expect(sanitizeJson(result)).toMatchSnapshot();
  }, 120000);

  it("generates a more complex schema", async () => {
    const module = new TerraformModuleConstraint(
      "terraform-aws-modules/eks/aws@7.0.1",
    );
    const target = new ConstructsMakerModuleTarget(module, Language.TYPESCRIPT);
    const result = await readModuleSchema(target);
    expect(sanitizeJson(result)).toMatchSnapshot();
  }, 120000);

  it("generates a local module", async () => {
    const module = new TerraformModuleConstraint({
      name: "local_module",
      fqn: "local_module",
      source: path.resolve(__dirname, "fixtures", "local-module"),
    });
    const target = new ConstructsMakerModuleTarget(module, Language.TYPESCRIPT);
    const result = await readModuleSchema(target);
    expect(sanitizeJson(result)).toMatchSnapshot();
  }, 120000);

  it("generates a local module with inline comments in type constraints", async () => {
    const module = new TerraformModuleConstraint({
      name: "local_module",
      fqn: "local_module",
      source: path.resolve(
        __dirname,
        "fixtures",
        "local-module-inline-comments",
      ),
    });
    const target = new ConstructsMakerModuleTarget(module, Language.TYPESCRIPT);
    const result = await readModuleSchema(target);
    expect(sanitizeJson(result)).toMatchSnapshot();
  }, 120000);

  it("generates a local module that requires provider configuration aliases", async () => {
    const module = new TerraformModuleConstraint({
      name: "local_module",
      fqn: "local_module",
      source: path.resolve(
        __dirname,
        "fixtures",
        "local-module-provider-aliases",
      ),
    });
    const target = new ConstructsMakerModuleTarget(module, Language.TYPESCRIPT);
    const result = await readModuleSchema(target);
    expect(sanitizeJson(result)).toMatchSnapshot();
  }, 120000);

  it("surfaces the terraform failure when a module cannot be fetched", async () => {
    const module = new TerraformModuleConstraint({
      name: "local_module",
      fqn: "local_module",
      source: "./this-module-does-not-exist",
    });
    const target = new ConstructsMakerModuleTarget(module, Language.TYPESCRIPT);

    // the fetch is run tolerantly so a module declaring configuration_aliases
    // gets a second chance - everything else has to keep failing loudly
    await expect(readModuleSchema(target)).rejects.toThrow(
      /get exited with code/,
    );
  }, 120000);

  it("generates a local json module", async () => {
    const module = new TerraformModuleConstraint({
      name: "local_module",
      fqn: "local_module",
      source: path.resolve(__dirname, "fixtures", "local-json-module"),
    });
    const target = new ConstructsMakerModuleTarget(module, Language.TYPESCRIPT);
    const result = await readModuleSchema(target);
    expect(sanitizeJson(result)).toMatchSnapshot();
  }, 120000);

  it("generates a local json module that requires provider configuration aliases", async () => {
    const module = new TerraformModuleConstraint({
      name: "local_module",
      fqn: "local_module",
      source: path.resolve(
        __dirname,
        "fixtures",
        "local-json-module-provider-aliases",
      ),
    });
    const target = new ConstructsMakerModuleTarget(module, Language.TYPESCRIPT);
    const result = await readModuleSchema(target);
    expect(sanitizeJson(result)).toMatchSnapshot();
  }, 120000);
});

describe("sanitizeProviderSchema", () => {
  it("sanitizes a provider schema", () => {
    const schema: ProviderSchema = {
      format_version: "0.1" as const,
      provider_versions: {
        "registry.terraform.io/hashicorp/null": "3.1.0",
      },
      provider_schemas: {
        "registry.terraform.io/hashicorp/null": {
          provider: {
            version: 0,
            block: {
              attributes: {
                version: {
                  type: "string",
                  required: true,
                },
                correct: {
                  type: ["list", "string"],
                },
                incorrect: {
                  type: ["list", "string", "list", "string"] as any,
                },
              },
              block_types: {
                triggers: {
                  nesting_mode: "single",
                  block: {
                    attributes: {
                      correct: {
                        type: ["list", "string"],
                      },
                      incorrect: {
                        type: ["list", "string", "list", "string"] as any,
                      },
                    },
                    block_types: {},
                  },
                },
              },
            },
          },
          resource_schemas: {
            null_resource: {
              version: 0,
              block: {
                attributes: {
                  id: {
                    type: "string",
                    computed: true,
                  },
                  correct: {
                    type: ["list", "string"],
                  },
                  incorrect: {
                    type: ["list", "string", "list", "string"] as any,
                  },
                },
                block_types: {
                  triggers: {
                    nesting_mode: "single",
                    block: {
                      attributes: {
                        triggers: {
                          type: "string",
                          optional: true,
                        },
                        correct: {
                          type: ["list", "string"],
                        },
                        incorrect: {
                          type: ["list", "string", "list", "string"] as any,
                        },
                      },
                      block_types: {},
                    },
                  },
                },
              },
            },
          },
          data_source_schemas: {},
          ephemeral_resource_schemas: {
            null_ephemeral: {
              version: 0,
              block: {
                attributes: {
                  correct: {
                    type: ["list", "string"],
                  },
                  incorrect: {
                    type: ["list", "string", "list", "string"] as any,
                  },
                },
                block_types: {},
              },
            },
          },
        },
      },
    };

    const result = sanitizeProviderSchema(schema);
    expect(result).toMatchSnapshot();
  });
});
