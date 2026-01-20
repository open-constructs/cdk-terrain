# cdk-terrain-example

## Prerequisite

Install cdktn

```
~$ npm install --global cdktn-cli
```

Verify the installation

```
~$ cdktn

Commands:
  cdktn deploy [OPTIONS]   Deploy the given stack
  cdktn destroy [OPTIONS]  Destroy the given stack
  cdktn diff [OPTIONS]     Perform a diff (terraform plan) for the given stack
  cdktn get [OPTIONS]      Generate CDK Constructs for Terraform providers and modules.
  cdktn init [OPTIONS]     Create a new cdktn project from a template.
  cdktn login              Retrieves an API token to connect to HCP Terraform.
  cdktn synth [OPTIONS]    Synthesizes Terraform code for the given app in a directory.
```

Install Pipenv

```
~$ brew install pipenv
```

Install Dependency Library

```
~$ pipenv install
```

## Get Started

Generate CDK Terrain constructs for Terraform provides and modules used in the project.

```
~$ cdktn get
```

Compile and generate Terraform configuration

```
~$ cdktn synth
```

The above command will create a folder called `cdktf.out` that contains all Terraform JSON configuration that was generated.

Run cdktn-cli commands

```bash
cdktn diff
cdktn deploy
```
