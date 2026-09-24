// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  Dispatcher,
} from "undici";
import { OPENTOFU_REGISTRY, TERRAFORM_REGISTRY } from "@cdktn/commons";
import { ProviderConstraint } from "../../../lib/dependencies/dependency-manager";
import { getLatestVersion } from "../../../lib/dependencies/registry-api";

describe("getLatestVersion", () => {
  let mockAgent: MockAgent;
  let originalDispatcher: Dispatcher;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
  });

  const versionsPath = "/v1/providers/hashicorp/random/versions";
  const body = { id: "hashicorp/random", versions: [{ version: "3.7.2" }] };

  it("asks the Terraform registry by default", async () => {
    mockAgent
      .get("https://registry.terraform.io")
      .intercept({ path: versionsPath })
      .reply(200, body);

    const constraint = ProviderConstraint.fromConfigEntry("hashicorp/random");
    expect(await getLatestVersion(constraint)).toBe("3.7.2");
  });

  it("asks the OpenTofu registry when the project targets it", async () => {
    mockAgent
      .get("https://registry.opentofu.org")
      .intercept({ path: versionsPath })
      .reply(200, { ...body, versions: [{ version: "3.9.1" }] });

    // A bare source expands against the project's registry.
    const constraint = ProviderConstraint.fromConfigEntry(
      "hashicorp/random",
      OPENTOFU_REGISTRY,
    );
    expect(constraint.source).toBe("registry.opentofu.org/hashicorp/random");
    expect(await getLatestVersion(constraint)).toBe("3.9.1");
  });

  it("honours an explicitly qualified source over the project's target", async () => {
    mockAgent
      .get("https://registry.opentofu.org")
      .intercept({ path: versionsPath })
      .reply(200, { ...body, versions: [{ version: "3.9.1" }] });

    // OpenTofu users have been told to fully qualify; that must keep working
    // even when the project declares no targetVersions.
    const constraint = ProviderConstraint.fromConfigEntry(
      "registry.opentofu.org/hashicorp/random",
    );
    expect(constraint.isFromPublicRegistry()).toBe(true);
    expect(await getLatestVersion(constraint)).toBe("3.9.1");
  });

  it("treats a private registry as unqueryable", () => {
    const constraint = ProviderConstraint.fromConfigEntry(
      "registry.example.com/acme/thing",
    );
    expect(constraint.isFromPublicRegistry()).toBe(false);
  });

  it("returns null for a provider the registry does not have", async () => {
    mockAgent
      .get("https://registry.opentofu.org")
      .intercept({ path: versionsPath })
      .reply(404, "");

    const constraint = ProviderConstraint.fromConfigEntry(
      "hashicorp/random",
      OPENTOFU_REGISTRY,
    );
    expect(await getLatestVersion(constraint)).toBeNull();
  });
});

describe("registry browse URLs", () => {
  it("point at each registry's own provider listing", () => {
    expect(TERRAFORM_REGISTRY.browseUrl).toBe(
      "https://registry.terraform.io/browse/providers",
    );
    // registry.opentofu.org/browse/providers is a 404; the listing lives here.
    expect(OPENTOFU_REGISTRY.browseUrl).toBe(
      "https://search.opentofu.org/providers",
    );
  });
});
