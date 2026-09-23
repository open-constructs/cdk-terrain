// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  OPENTOFU_REGISTRY,
  TERRAFORM_REGISTRY,
  registryForTargetVersions,
} from "./registry";

describe("registryForTargetVersions", () => {
  it("uses OpenTofu only when it is the sole declared product", () => {
    expect(registryForTargetVersions({ opentofu: ">=1.6.0" })).toBe(
      OPENTOFU_REGISTRY,
    );
  });

  it.each([
    ["terraform only", { terraform: ">=1.5.7" }],
    ["both declared", { terraform: ">=1.5.7", opentofu: ">=1.6.0" }],
    ["nothing declared", undefined],
  ])("uses Terraform for %s", (_name, targets) => {
    expect(registryForTargetVersions(targets)).toBe(TERRAFORM_REGISTRY);
  });
});

describe("docsUrl", () => {
  it("builds Terraform registry paths", () => {
    const r = TERRAFORM_REGISTRY;
    expect(r.docsUrl("hashicorp", "random", "3.7.2", "provider")).toBe(
      "https://registry.terraform.io/providers/hashicorp/random/3.7.2/docs",
    );
    expect(
      r.docsUrl("hashicorp", "random", "3.7.2", "resource", "password"),
    ).toBe(
      "https://registry.terraform.io/providers/hashicorp/random/3.7.2/docs/resources/password",
    );
    expect(
      r.docsUrl("hashicorp", "local", "2.5.2", "data-source", "file"),
    ).toBe(
      "https://registry.terraform.io/providers/hashicorp/local/2.5.2/docs/data-sources/file",
    );
  });

  // Shapes follow getDocumentationUrl.ts in opentofu/registry-ui.
  it("builds OpenTofu registry paths", () => {
    const r = OPENTOFU_REGISTRY;
    expect(r.docsUrl("hashicorp", "random", "3.7.2", "provider")).toBe(
      "https://search.opentofu.org/provider/hashicorp/random/v3.7.2/docs",
    );
    expect(
      r.docsUrl("hashicorp", "random", "3.7.2", "resource", "password"),
    ).toBe(
      "https://search.opentofu.org/provider/hashicorp/random/v3.7.2/docs/resources/password",
    );
    expect(
      r.docsUrl("hashicorp", "local", "2.5.2", "data-source", "file"),
    ).toBe(
      "https://search.opentofu.org/provider/hashicorp/local/v2.5.2/docs/datasources/file",
    );
  });

  // TODO(#444): drop the fallback once opentofu/registry-ui#348 ships an
  // ephemeral-resource route; this assertion is what will fail when it does.
  it("falls back to the provider page for OpenTofu ephemeral resources", () => {
    expect(
      OPENTOFU_REGISTRY.docsUrl(
        "hashicorp",
        "random",
        "3.7.2",
        "ephemeral-resource",
        "password",
      ),
    ).toBe("https://search.opentofu.org/provider/hashicorp/random/v3.7.2/docs");
  });
});
