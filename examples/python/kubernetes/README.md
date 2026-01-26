# python-kubernetes

A CDK Terrain application in Python to demonstrate use of the Kubernetes Provider according to the [HashiCorp Learn Guide](https://learn.hashicorp.com/terraform/kubernetes/deploy-nginx-kubernetes).

## Usage

Install Pipenv using Homebrew by running:

```bash
$ brew install pipenv
```

You can install Pipenv by visiting the [website](https://pipenv.pypa.io/en/latest/).

Install project dependencies

```shell
pipenv install
```

Generate CDK Terrain constructs for Terraform providers and modules used in the project.

```bash
cdktn get
```

You can now edit the `main.py` file if you want to modify any code.

Compile and generate Terraform configuration

```bash
cdktn synth
```

The above command will create a folder called `cdktf.out` that contains all Terraform JSON configuration that was generated.

Run cdktn-cli commands

```bash
cdktn diff
cdktn deploy
```
