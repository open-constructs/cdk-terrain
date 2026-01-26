# Example for UCloud based on Typescript

This is based on the provided examples for other providers but adapted to UCloud

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
