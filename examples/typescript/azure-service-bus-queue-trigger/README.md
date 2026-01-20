# Azure Function with Service Bus Queue Trigger

An example for Azure Function App with a Service Bus Queue Trigger

## Usage

Install project dependencies

```shell
yarn install
```

Generate CDK Terrain constructs for Terraform provides and modules used in the project.

```bash
cdktn get
```

Compile the TypeScript application

```bash
tsc
```

Generate Terraform configuration

```bash
cdktn synth
```

The above command will create a folder called `cdktf.out` that contains all Terraform JSON configuration that was generated.

Run cdktn-cli commands

```bash
cdktn diff
cdktn deploy
```

> At this step your Function App is deployed but not the application code

## Deploy the code of your Function App

You need then to deploy a function with a [service bus trigger](https://docs.microsoft.com/en-us/azure/azure-functions/functions-bindings-service-bus-trigger?tabs=javascript) in the `myapp-function` Function App.

Here are the parameters to set:

- `type`: `serviceBusTrigger`
- `direction`: `in`
- `queueName`: `my-app-queue`
- `connection`: `ServiceBusConnectionString`
