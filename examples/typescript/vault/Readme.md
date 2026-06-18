# Vault Example

A simple example for the Vault provider

### Setup

In order to use this for development, it's the easiest to use the Docker vault image:

```
npm install
npm run docker:run
npm run docker:token # returns the Root Vault token
```

Set that token in the provider config in [main.ts](./main.ts)

```
cdktn get
cdktn deploy
```

### Teardown

```
npm run docker:stop
```
