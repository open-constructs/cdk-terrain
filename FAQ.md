# Frequently Asked Questions

## Table of Contents

- [What is CDK Terrain?](#what-is-cdk-terrain)
- [Why the name "CDK Terrain"?](#why-the-name-cdk-terrain)
- [What is the relationship between CDK Terrain and CDKTF?](#what-is-the-relationship-between-cdk-terrain-and-cdktf)
- [Who will maintain CDK Terrain?](#who-will-maintain-cdk-terrain)
- [What is the relationship between CDK Terrain and OpenTofu?](#what-is-the-relationship-between-cdk-terrain-and-opentofu)
- [Does CDK Terrain support OpenTofu?](#does-cdk-terrain-support-opentofu)
- [Is CDK Terrain compatible with existing CDKTF projects?](#is-cdk-terrain-compatible-with-existing-cdktf-projects)
- [What Terraform providers will be supported?](#what-terraform-providers-will-be-supported)
- [What programming languages will be supported?](#what-programming-languages-will-be-supported)
- [How will CDK Terrain be licensed?](#how-will-cdk-terrain-be-licensed)
- [What is the development roadmap?](#what-is-the-development-roadmap)
- [How can I migrate my existing CDKTF project to CDK Terrain?](#how-can-i-migrate-my-existing-cdktf-project-to-cdk-terrain)
- [How can developers contribute to CDK Terrain?](#how-can-developers-contribute-to-cdk-terrain)
- [Where can I find CDK Terrain documentation?](#where-can-i-find-cdk-terrain-documentation)
- [How can I stay updated on CDK Terrain developments?](#how-can-i-stay-updated-on-cdk-terrain-developments)
- [Will HashiCorp be involved in CDK Terrain?](#will-hashicorp-be-involved-in-cdk-terrain)
- [What is the TerraConstructs/terraform-cdk Fork?](#what-is-the-terraconstructsterraform-cdk-fork)
- [Can companies offer commercial support for CDK Terrain?](#can-companies-offer-commercial-support-for-cdk-terrain)
- [What happens to existing CDKTF provider packages?](#what-happens-to-existing-cdktf-provider-packages)

### What is CDK Terrain?

CDK Terrain (cdktn - [cdktn.io](http://cdktn.io)) is a community-driven continuation of the Cloud Development Kit for Terraform (CDKTF). It allows developers to define Terraform infrastructure using familiar programming languages like TypeScript and Python, synthesizing that code into standard Terraform JSON configuration.

### Why the name "CDK Terrain"?

The name "CDK Terrain" reflects the project's purpose of helping developers shape their infrastructure landscape. The abbreviation "cdktn" follows the established pattern of other CDK projects (cdk8s, cdktf) while establishing a distinct identity for the community-driven project.

### What is the relationship between CDK Terrain and CDKTF?

CDK Terrain is a community-driven fork of CDKTF, created with HashiCorp's blessing following their deprecation announcement. The project preserves the original codebase and commit history while enabling continued development under the [Open Construct Foundation](https://the-ocf.org)'s stewardship.

### Who will maintain CDK Terrain?

[The Open Construct Foundation](https://the-ocf.org) is actively forming a maintainer group consisting of experienced CDKTF users and contributors from [the community](https://cdk.dev). Maintainers will be selected based on their expertise, commitment, and alignment with the project's goals. The foundation provides oversight to ensure consistent governance and quality standards.

### What is the relationship between CDK Terrain and OpenTofu?

[OpenTofu](https://opentofu.org) is an independent, [CNCF](https://cncf.io)-hosted project focused on providing an open-source, Terraform-compatible CLI and ecosystem. CDK Terrain is governed by the Open Construct Foundation and is developed independently. 

The two projects are not formally affiliated. However, the relationship is open and constructive. The OpenTofu team has offered its guidance and expertise and is a helpful resource for discussions around compatibility, workflows, and ecosystem considerations.

Any interaction between CDK Terrain and OpenTofu is informal, community-driven, and non-exclusive. There are no commitments around feature prioritization, roadmap alignment, or long-term integration on either side.

### Does CDK Terrain support OpenTofu?

Yes. CDK Terrain is designed to remain compatible with both Terraform and OpenTofu.

CDK Terrain synthesizes standard Terraform configuration, allowing users to choose their preferred execution engine. At present, users can run CDK Terrain–generated output with either Terraform or OpenTofu without special configuration or feature gaps compared to the last CDKTF release.

One of the long-term goals of the CDK Terrain fork is to remove historical constraints that limited evolution in the original project, including slow adoption of newer Terraform features. Decisions about which features, versions, or execution engines to support will be guided by community needs, maintainer capacity, and ecosystem stability rather than fixed assumptions.

The Open Construct Foundation intends to remain pragmatic and transparent in these decisions, with the goal of supporting both ecosystems where it is feasible and sustainable to do so.

> CDK Terrain aims to remain execution-engine agnostic, enabling users to choose between Terraform and OpenTofu based on their operational and licensing preferences.

### Is CDK Terrain compatible with existing CDKTF projects?

Yes, CDK Terrain is designed as a drop-in replacement for CDKTF. Existing projects should work with minimal changes, primarily updating package names and imports. Detailed migration guides will be provided to assist users in transitioning their codebases.

### What Terraform providers will be supported?

CDK Terrain will support all Terraform providers leveraging provider generation tooling that CDKTF offered. An initial set of pre-built provider packages are published re-using a similar infrastructure to what Hashicorp offered. These repositories are managed by the [cdktn-repository-manager](https://github.com/cdktn-io/cdktn-repository-manager) and are actively being worked on. The community will maintain popular provider packages, and users can continue to generate bindings for any Terraform provider.

### What programming languages will be supported?

Initial releases will support TypeScript and Python, the two most widely used languages in the CDKTF community. Support for additional languages (Java, C#, Go) will be added based on community demand and contributor availability.

### How will CDK Terrain be licensed?

CDK Terrain will be licensed under the Mozilla Public License 2.0 (MPL 2.0), the same license used by the original CDKTF project. This ensures continuity for existing users and maintains the project's open-source nature.

### What is the development roadmap?

The immediate focus is on establishing the project infrastructure, forming the maintainer group, and releasing an initial version that ensures compatibility with existing CDKTF projects. Subsequent releases will address bug fixes, security updates, and community-requested features. A detailed roadmap will be published once the maintainer group is established.

### How can I migrate my existing CDKTF project to CDK Terrain?

Migration will primarily involve updating package names and imports in your project. The CDK Terrain documentation will include step-by-step migration guides for each supported language. The goal is to make migration as straightforward as possible while preserving your existing infrastructure code.

### How can developers contribute to CDK Terrain?

Developers can contribute by joining the community and help realise the project roadmap through collabarative and coordinated efforst. This will be crucial for establishing the new foundations for the CDK Terrain project. Join the `#cdk-terrain` channel on the [cdk.dev](https://cdk.dev) Slack workspace to get started.

### Where can I find CDK Terrain documentation?

Documentation will be available on the project's GitHub repository at [github.com/open-constructs/cdk-terrain](https://github.com/open-constructs/cdk-terrain). As the project matures, dedicated documentation sites will be established.

### How can I stay updated on CDK Terrain developments?

Developers can stay updated on CDK Terrain by following the project's GitHub repository and actively participating in community discussions on the cdk.dev Slack workspace.

### Will HashiCorp be involved in CDK Terrain?

HashiCorp has given their blessing for the community to fork CDKTF through this initiative. While HashiCorp is not directly involved in CDK Terrain's ongoing development, the foundation appreciates their support in enabling this community-driven continuation.

### What is the TerraConstructs/terraform-cdk Fork?

The TerraConstructs fork was an initial exploration to estimate the scale and help establish early ROADMAPs and risk assesments. This effort is now being hosted and coordinated together with the Open Constructs foundation.

### Can companies offer commercial support for CDK Terrain?

Yes, companies are welcome to offer commercial support services for CDK Terrain, enabling them to provide additional value to enterprise users who require dedicated assistance.

### What happens to existing CDKTF provider packages?

The community will maintain packages for popular Terraform providers. Provider packages will be published under the CDK Terrain namespaces across npmjs and Pypi. Refer to [github.com/cdktn-io](https://github.com/cdktn-io). Additional migration tooling will be provided to help users update their dependencies.
