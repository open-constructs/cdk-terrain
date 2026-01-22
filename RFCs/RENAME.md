# Renaming Protocol: `cdktf` to `cdktn`

This document outlines the strategy, decision points, and impact analysis for renaming the Cloud Development Kit for Terraform (CDKTF) from its HashiCorp-branded origins to the new OpenConstructs-maintained `cdk-terrain` (`cdktn`) identity.

## 1. Project Identity & Scope

*   **Project Name:** `cdk-terrain`
*   **CLI Command:** `cdktn` (replacing `cdktf`)
*   **NPM Scope:** `@cdktn` (replacing `@cdktf`)
*   **GitHub Organizations:**
  - `open-constructs` (replacing `hashicorp`)
  - `cdktn-io` (replacing `cdktf|hashicorp` context in older docs/links, note: user specified `cdktn-io` for GitHub org).

## 2. Package Renaming & Publication Targets

We must publish packages under new names and scopes.

### NPM (Node.js)
*   **Scope:** Change `@cdktf/*` to `@cdktn/*`.
*   **Packages:**
    *   `cdktf` -> `cdktn` (The core library)
    *   `cdktf-cli` -> `cdktn-cli` (The CLI tool)
    *   `@cdktf/cli-core` -> `@cdktn/cli-core`
    *   `@cdktf/commons` -> `@cdktn/commons`
    *   `@cdktf/provider-generator` -> `@cdktn/provider-generator`
    *   `@cdktf/hcl2cdk` -> `@cdktn/hcl2cdk`
*   **Prebuilt Providers:** `@cdktf/provider-<name>` -> `@cdktn/provider-<name>`

### PyPI (Python)
*   **Package Name:** `cdktf` -> `cdktn`
*   **Module Name:** `cdktf` -> `cdktn` (Imports will change from `from cdktf import ...` to `from cdktn import ...`)
*  **Prebuilt Providers:** `cdktf-cdktf-provider-foo` -> `cdktn-provider-foo`

### Go
*   **Module:** `github.com/hashicorp/terraform-cdk-go/cdktf` -> `github.com/open-constructs/cdk-terrain-go/cdktn`
*   **Package Name:** `cdktf` -> `cdktn`

### Maven (Java)
*   **GroupId:** `com.hashicorp` -> `io.cdktn`
*   **ArtifactId:** `cdktf` -> `cdktn`
*   **Package Namespace:** `com.hashicorp.cdktf` -> `io.cdktn.cdktn`

### Nuget (C#)
*   **PackageId:** `HashiCorp.Cdktf` -> `Io.Cdktn` (Proposed)
*   **Namespace:** `HashiCorp.Cdktf` -> `Io.Cdktn`

---

## 3. Backward Compatibility & Legacy Support

To ease the transition, we must support legacy configuration and patterns where feasible.

### Configuration Files
*   **Manifest:** `cdktf.json` (legacy fallback - Default).
*   **Output Directory:** Default to `cdktf.out`.
    *   *Legacy:* Maintain default `.gitignore` entries for `cdktf.out`, `cdktf.log`.
*   **Home Directory:** Default to `~/.cdktf`.

### Context & Environment
*   **Environment Variables:** Support `CDKTF_*` vars (e.g., `CDKTF_HOME`).
*   **Context Keys:**
    *   `cdktfVersion` + `cdktnVersion` (Inject both for compatibility?).
    *   `cdktfJsonPath`, `cdktfRelativeModules`.
    *   `cdktfJsonPath`, `cdktfRelativeModules` `cdktfStaticModuleAssetHash`

### CLI Commands
*   The `cdktf` command should ideally redirect to `cdktn` if installed via the new package, or `cdktn` should alias legacy subcommands if they change.

---

## 4. Internal Architecture & Breaking Changes

### Internal Symbols & IDs
**CRITICAL:** Changing internal IDs affects the synthesized Terraform JSON, which triggers resource replacement in Terraform state.

*   **`Symbol.for("cdktf.TerraformModuleAsset")`**:
    *   *Issue:* Used for runtime type checks and internal logic.
    *   *Option A (Clean Break):* Change to `cdktn.TerraformModuleAsset`. Requires all libraries to be recompiled against `cdktn`. Mixed versions will fail runtime symbol lookups.
    *   *Option B (Dual Support):* Register both symbols or keep the legacy symbol string for a transition period.
    *   *Recommendation:* Change the symbol string to `cdktn...` but acknowledge this creates a hard boundary between `cdktf` and `cdktn` ecosystems and must be accomodated for in Migration script and migration advise.

*   **Synthesized Logical IDs (e.g., `__cdktf_module_asset`):**
    *   *Issue:* If we rename this to `__cdktn_module_asset`, Terraform will see it as a new resource and try to destroy/create.
    *   *Mitigation:*
        1.  **Migration Script:** The `cdktn` CLI could generate a `moved` block in the synthesized JSON or provide a helper to generate `terraform state mv` commands.
        2.  **Legacy Mode:** A config flag in `cdktf.json` (`legacyIds: true`) to emit old IDs.

### Annotations
*   `@cdktf/info`, `@cdktf/warn`, `@cdktf/error` annotations in the manifest.
*   *Action:* Rename to `@cdktn/info`, etc. CLI must be updated to parse these new keys.

---

## 5. Migration Strategy for Users

We will need to provide a robust `cdktn upgrade` or `cdktn migrate` command.

1.  **Dependency Updates:**
    *   Uninstall `@cdktf/*`.
    *   Install `@cdktn/*`.
    *   Update `package.json` scripts (e.g., `cdktf synth` -> `cdktn synth`).

2.  **Code Refactoring:**
    *   **Imports:** Regex-replace `import ... from "cdktf"` to `"cdktn"`.
    *   **Namespaces:** Replace `com.hashicorp.cdktf` (Java), `HashiCorp.Cdktf` (C#).
    *   **Constructs:** If any construct names changed (unlikely for core, but possible for providers).

3.  **State Migration:**
    *   If internal IDs change, generate `moved {}` blocks (assume TF supports moved blocks?).

---

## 6. Implementation Checklist (Decision Points)

- [ ] **Global Replace:** `hashicorp/terraform-cdk` -> `open-construcs/cdk-terrain` (Repo URLs).
  - [ ] Exceptions: old gh issues / blob references 
- [ ] **Global Replace:** `github.com/cdktf` (gh org) -> `github.com/cdktn-io` (where applicable for ownership).
- [ ] **Templates:** Update `packages/@cdktf/cli-core/templates` to scaffold `cdktn` projects.
- [ ] **Examples:** Update all `examples/` to use new packages and imports.
- [ ] **Provider Generator:** Ensure generated providers use the new core library (`cdktn`) and reference the correct helper packages.
- [ ] **Copyright Headers:** 
  - [ ] DO NOT MODIFY / KEEP (even add identical headers to NEW files to avoid issues - advise from OpenTofu) - maintain attribution as required by MPL-2.0
  - [ ] Optional: Additional `CDK Terrain Maintainers` attribution headers in same format

## 7. Edge Cases Identified

*   **Provider Constraints:** `hashicorp/aws` refers to the Terraform Provider source. This **must not** change. Only the CDKTF binding package changes name (cdktf/provider-aws -> cdktn/provider-aws).
*   **Backend Configurations:** `organization: "hashicorp"` in tests/examples is likely referring to a real TFC org. These need to change to a `cdktn` testing org or remain if we have access.
*   **Environment Variables:** `TF_` vars belong to Terraform and stay. `CDKTF_` vars stay.
*   **Polyglot Interop:** Ensure `jsii` configuration in `package.json` correctly maps the new NPM package to the new foreign language namespaces.
*   **Code examples**
  - init -> Options.cdktfVersion
  - DependencyManager -> provider -> provider.cdktfVersion ??
  - @cdktf/commons -> getPackageVersion(language, "cdktn") (used by cmd handlers and check environment)  
  - links to old repo blobs, issues, docs, ...
    - https://github.com/hashicorp/terraform-cdk/blob/1fb8588095a55d...........
    - https://developer.hashicorp.com/terraform/cdktf/............ (until docs site is migrated)

## 8. Infra

update docker image repo and references 
 - hashicorp/jsii-terraform
 - docker.mirror.hashicorp.services/hashicorp/jsii-terraform

must provide Vercel Static Redirects see:
  https://github.com/skorfmann/cdktf-redirects
ref:
  https://github.com/open-constructs/cdk-terrain/blob/c5f20affb4bdc1d61efb0b7532dcad30d30007b8/cdk.tf/vercel.json#L242

// https://github.com/open-constructs/cdk-terrain/blob/3b6d0f954e59796927ebac05742da7c3c7ff7452/packages/@cdktf/cli-core/src/lib/dependencies/prebuilt-providers.ts#L18
const providersMapUrl = `https://www.cdk.tf/.well-known/prebuilt-providers.json`;
 -> point to https://raw.githubusercontent.com/cdktn-io/cdktn-repository-manager/main/provider.json

