# Example for Azure Cloud based on Typescript

This resembles the example for the Azure Cloud at [Hashicorp Learn](https://learn.hashicorp.com/collections/terraform/azure-get-started)

## Usage

Install project dependencies

```shell
yarn install
```

Generate CDK Terrain constructs for Terraform provides and modules used in the project.

```bash
cdktn get
```

You can now edit the `main.ts` file if you want to modify any code.

Generate Terraform configuration

```bash
cdktn synth
```

The above command will create a folder called `cdktf.out` that contains all Terraform JSON configuration that was generated.

See changes `cdktn diff` and deploy via `cdktn deploy`.

When you're done run `cdktn destroy`.

You need

- `az cli` : [download page docs](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli?view=azure-cli-latest)
