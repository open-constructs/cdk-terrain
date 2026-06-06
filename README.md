# CDK Terrain

> [!IMPORTANT]
> CDK Terrain migration guides available at [migrating to v0.23](https://cdktn.io/docs/release/upgrade-guide-v0-23)
> Refer to the [FAQ](./FAQ.md) for clarifications about this fork

CDK Terrain (CDKTN) is a community fork of the Cloud Development Kit for Terraform (CDKTF).
CDKTF/CDKTN allows you to use familiar programming languages to define cloud infrastructure
and provision it through OpenTofu or Terraform. This gives you access to the
entire OpenTofu/Terraform ecosystem without learning HashiCorp Configuration Language (HCL)
and lets you leverage the power of your existing toolchain for testing, dependency management, etc.

We currently support TypeScript, Python, Java, C# and Go.

![terraform platform](./docs/terraform-platform.png)

CDKTN includes two packages:

- [cdktn-cli](./packages/cdktn-cli) - A CLI that allows users to run commands to initialize, import, and synthesize CDK Terrain applications.
- [cdktn](./packages/cdktn) - A library for defining Terraform resources using programming constructs.

## Get Started

- [Overview](https://cdktn.io/docs)
- [Examples and Guides](https://cdktn.io/docs/examples-and-guides/examples) covering Typescript, Python, Java, C# and Go

> **Hands-on:** Try the tutorials in the [Tutorials](https://cdktn.io/docs/tutorials/install) section.

## Documentation

Refer to the [documentation](https://cdktn.io/docs) for more detail about how to build and manage CDKTN applications, including:

- [Application Architecture](https://cdktn.io/docs/concepts/cdktn-architecture): Learn the tools and processes that CDKTN uses to leverage the Terraform ecosystem and convert code into Terraform configuration files. It also explains the major components of a CDKTN application and how those pieces fit together.

- [Project Setup](https://cdktn.io/docs/create-and-deploy/project-setup): Learn how to create a new CDKTN project from a pre-built or custom template. Also learn how to convert an existing HCL project into a CDKTN application.

- [Unit Tests](https://cdktn.io/docs/test/unit-tests): Learn how to test your application in Typescript with jest.

- [Examples](https://cdktn.io/docs/examples-and-guides/examples): Reference example projects in every supported language and review explanatory videos and other resources.

## Community

The development team would love your feedback to help guide the project.

- Contribute using the [CONTRIBUTING.md](./CONTRIBUTING.md) guide.
- Ask a question on the [the cdk.dev - #cdk-terrain channel](https://cdk.dev)).
- Report a [bug](https://github.com/open-constructs/cdk-terrain/issues/new?assignees=&labels=bug&template=bug-report.md&title=) or request a new [feature](https://github.com/open-constructs/cdk-terrain/issues/new?assignees=&labels=enhancement&template=feature-request.md&title=).
- Browse all [open issues](https://github.com/open-constructs/cdk-terrain/issues).

## Build

For prerequisites, refer to the [following](./CONTRIBUTING.md#prerequisites).

Clone the project repository.

```bash
git clone https://github.com/open-constructs/cdk-terrain.git
```

Download dependencies.

```bash
cd cdk-terrain/
pnpm install
```

Build the project and packages.

```bash
pnpm build
```
