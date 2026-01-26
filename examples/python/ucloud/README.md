# python-ucloud

A CDK Terrain application in Python.

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

```bash
cdktn synth
```

The above command will create a folder called `cdktf.out` that contains all Terraform JSON configuration that was generated.

```bash
cdktn deploy
```

Deploy the stack!
