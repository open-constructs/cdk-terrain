# CDK Terrain

> [!IMPORTANT]
> This is a work in progress and details on this README will be updated as work progresses.
> Refer to the [FAQ](./FAQ.md) for clarifications

CDK Terrain (CDKTN) is a community fork of the Cloud Development Kit for Terraform (CDKTF).
CDKTF/CDKTN allows you to use familiar programming languages to define cloud infrastructure
and provision it through HashiCorp Terraform or OpenTofu. This gives you access to the
entire Terraform/OpenTofu ecosystem without learning HashiCorp Configuration Language (HCL)
and lets you leverage the power of your existing toolchain for testing, dependency management, etc.

We currently support TypeScript, Python and Go.

![terraform platform](./docs/terraform-platform.png)

CDKTN includes two packages:

- [cdktn-cli](./packages/cdktn-cli) - A CLI that allows users to run commands to initialize, import, and synthesize CDK Terrain applications.
- [cdktn](./packages/cdktn) - A library for defining Terraform resources using programming constructs.

## Get Started

Choose a language:

- [TypeScript](https://developer.hashicorp.com/terraform/tutorials/cdktf/cdktf-build?in=terraform%2Fcdktf&variants=cdk-language%3Atypescript)
- [Python](https://developer.hashicorp.com/terraform/tutorials/cdktf/cdktf-build?in=terraform%2Fcdktf&variants=cdk-language%3Apython)
- [Java](https://developer.hashicorp.com/terraform/tutorials/cdktf/cdktf-build?in=terraform%2Fcdktf&variants=cdk-language%3Ajava)
- [C#](https://developer.hashicorp.com/terraform/tutorials/cdktf/cdktf-build?in=terraform%2Fcdktf&variants=cdk-language%3Acsharp)
- [Go](https://developer.hashicorp.com/terraform/tutorials/cdktf/cdktf-build?in=terraform%2Fcdktf&variants=cdk-language%3Ago)

> **Hands-on:** Try the tutorials in the [CDK for Terraform](https://learn.hashicorp.com/collections/terraform/cdktf) collection on HashiCorp Learn.

## Documentation

Refer to the [CDKTF documentation](https://developer.hashicorp.com/terraform/cdktf) for more detail about how to build and manage CDKTN applications, including:

- [Application Architecture](https://developer.hashicorp.com/terraform/cdktf/concepts/cdktf-architecture): Learn the tools and processes that CDKTN uses to leverage the Terraform ecosystem and convert code into Terraform configuration files. It also explains the major components of a CDKTN application and how those pieces fit together.

- [Project Setup](https://developer.hashicorp.com/terraform/cdktf/create-and-deploy/project-setup): Learn how to create a new CDKTN project from a pre-built or custom template. Also learn how to convert an existing HCL project into a CDKTN application.

- [Unit Tests](https://developer.hashicorp.com/terraform/cdktf/test/unit-tests): Learn how to test your application in Typescript with jest.

- [Examples](https://developer.hashicorp.com/terraform/cdktf/examples-and-guides/examples): Reference example projects in every supported language and review explanatory videos and other resources.

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
yarn install
```

Build the project and packages.

```bash
yarn build
```
