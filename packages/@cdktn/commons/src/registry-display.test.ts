// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  OPENTOFU_REGISTRY,
  TERRAFORM_REGISTRY,
  registryForTargetVersions,
} from "./registry";

// Generated prose names the registry its links point at; naming the wrong one
// produces text like "Refer to the Terraform Registry" above a
// search.opentofu.org link.
describe("registry display names track the link target", () => {
  it("names OpenTofu for an OpenTofu-only project", () => {
    const r = registryForTargetVersions({ opentofu: ">=1.6.0" });
    expect(r.displayName).toBe("OpenTofu Registry");
    expect(r.docsUrl("hashicorp", "random", "3.7.2", "provider")).toContain(
      "search.opentofu.org",
    );
  });

  it("names Terraform by default and when both are declared", () => {
    for (const targets of [
      undefined,
      { terraform: ">=1.5.7" },
      { terraform: ">=1.5.7", opentofu: ">=1.6.0" },
    ]) {
      const r = registryForTargetVersions(targets);
      expect(r.displayName).toBe("Terraform Registry");
      expect(r.docsUrl("hashicorp", "random", "3.7.2", "provider")).toContain(
        "registry.terraform.io",
      );
    }
  });

  it("every registry names itself", () => {
    expect(TERRAFORM_REGISTRY.displayName).toBe("Terraform Registry");
    expect(OPENTOFU_REGISTRY.displayName).toBe("OpenTofu Registry");
  });
});
