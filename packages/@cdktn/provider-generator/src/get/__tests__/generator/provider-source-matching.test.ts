// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  ConstructsMakerProviderTarget,
  Language,
  ProviderSchema,
  TerraformProviderConstraint,
} from "@cdktn/commons";
import { CodeMaker } from "codemaker";
import { TerraformProviderGenerator } from "../../generator/provider-generator";

// Builds a minimal provider schema keyed by a single FQPN. The provider body is
// intentionally empty (like the empty-provider-resources fixture) since these
// tests only exercise the schema-key <-> target-source matching logic.
const schemaWithKey = (fqpn: string): ProviderSchema => ({
  provider_schemas: {
    [fqpn]: { resource_schemas: null } as any,
  },
  provider_versions: {
    [fqpn]: "1.84.0",
  },
});

const targetForSource = (source: string) =>
  new ConstructsMakerProviderTarget(
    new TerraformProviderConstraint(`${source}@1.84.0`),
    Language.TYPESCRIPT,
  );

const generateFor = (schemaKey: string, source: string) => {
  const generator = new TerraformProviderGenerator(
    new CodeMaker(),
    schemaWithKey(schemaKey),
  );
  generator.generate(targetForSource(source));
  return generator;
};

describe("provider source matching against schema keys", () => {
  it("matches a shorthand source against an OpenTofu registry schema key", () => {
    // Regression test for #216: `tofu providers schema` returns keys under
    // registry.opentofu.org, so a shorthand source must not assume
    // registry.terraform.io.
    const generator = generateFor(
      "registry.opentofu.org/hashicorp/awscc",
      "hashicorp/awscc",
    );

    expect(Object.keys(generator.versions)).toContain(
      "registry.opentofu.org/hashicorp/awscc",
    );
  });

  it("matches a shorthand source against a Terraform registry schema key", () => {
    const generator = generateFor(
      "registry.terraform.io/hashicorp/awscc",
      "hashicorp/awscc",
    );

    expect(Object.keys(generator.versions)).toContain(
      "registry.terraform.io/hashicorp/awscc",
    );
  });

  it("keeps an explicit hostname strict and does not cross registries", () => {
    expect(() =>
      generateFor(
        "registry.opentofu.org/hashicorp/awscc",
        "registry.terraform.io/hashicorp/awscc",
      ),
    ).toThrow(/Could not find provider with constraint/);
  });

  it("matches an explicit hostname when it agrees with the schema key", () => {
    const generator = generateFor(
      "registry.opentofu.org/hashicorp/awscc",
      "registry.opentofu.org/hashicorp/awscc",
    );

    expect(Object.keys(generator.versions)).toContain(
      "registry.opentofu.org/hashicorp/awscc",
    );
  });
});
