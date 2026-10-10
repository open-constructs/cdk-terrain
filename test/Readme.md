# cdktn Integration Tests

This directory contains integration tests for the cdktn project.

Each subdirectory represents a target language, where each test is another nested folder, with an entrypoint of `test.ts`.
Tests are written in Typescript and Jest and can simulate user activity.

## Running Tests

You can either run individual tests by executing their entrypoint directly (e.g.
`npx jest --runInBand typescript/synth-app/test.ts`) or run all tests by executing `npx jest --runInBand`.

Tests assume the `cdktn` CLI is installed and in the PATH, and will use the same
version of the `cdktn` module (this is the behavior of `cdktn init`).

You can also execute a test (or all of them) against the `dist` build artifact:

```shell
$ pnpm install
$ pnpm build
$ pnpm run package # creates "dist/"
$ cd test
$ pnpm edge:install
$ ./run-against-dist.mjs npx jest --runInBand
```

## Writing Tests

1. Create a new subdirectory in the directory of your target language.
2. Create a file named `test.ts`

Test Environment:

- The test script is executed within a temporary working directory under
  /tmp/xxxx/test (where xxxx is some random tmp file).
- See existing tests as examples on how to bring in auxiliary files to the test.
- Test MUST NOT install any dependencies or the `cdktn` CLI. They can expect it
  to be available in the environment.
- To install dependencies from pacakge managers, use `pnpm`, `npm`, `pipenv`,
  `mvn` and `nuget`. Those programs will be shimmed to allow consuming local
  dependencies.

## Edge Provider Tests

To test all edge cases without building all providers we create an edge provider that contains all these edge cases.
The provider lives under `packages/@cdktn/provider-generator/lib/__tests__/edge-provider-schema` and the provider bindings are tested there through snapshots.
The root `build:edge-bindings` script generates the bindings into `packages/@cdktn/provider-generator/edge-provider-bindings`; GH Actions uploads them from there, and the `edge:install` command runs it and copies the result for a local run.

We also build a helper to translate an initial version of these tests through the different languages, `edge:translateTests` takes the typescript `main.ts` and translates it to the other languages. The translation is not perfect, but a good start.

## Running Against Different Terraform / OpenTofu Versions

Everything that shells out to a Terraform-compatible CLI honors the
`TERRAFORM_BINARY_NAME` environment variable (default: `terraform`). This
includes the `cdktn` CLI (init/diff/deploy), the optional binary verification
validation (runs `<binary> version` to check the installed CLI against the
declared `targetVersions`), and the unit-test matchers (`toPlanSuccessfully`
and friends run `<binary> init/plan`).

Note that function version validation does **not** shell out: it checks the
functions used through `Fn` against the declared `targetVersions` statically,
using the vendored availability matrix.

Which tests execute the binary:

- **Integration tests** that call `driver.diff()` / `driver.deploy()` (e.g.
  `typescript/variables`) run full `terraform init/plan/apply` cycles.
  Synth-only tests (e.g. `typescript/synth-app`) execute the binary at most
  for a `version` lookup, while purely static ones (e.g.
  `typescript/function-version-validation`, which deliberately runs against a
  nonexistent binary) never invoke a CLI at all.
- **Unit tests** in `packages/cdktn` run `terraform init/plan` through the
  testing matchers and `terraform version` through the binary verification
  validation (stubbed with `echo` in most validation tests).

### CI version matrix

`.terraform.versions.json` at the repository root drives the matrix:

- `available` — Terraform versions baked into the CI Docker image (see
  `Dockerfile`); each is installed as `/usr/local/bin/terraform<version>` with
  the `default` version symlinked to `terraform`.
- `tested` — the subset run in CI workflows, exported as
  `TERRAFORM_BINARY_NAME=terraform<version>` per matrix job.
- `opentofu.available` / `opentofu.default` — the same for OpenTofu, installed
  as `tofu<version>` with the default symlinked to `tofu`.

OpenTofu does not run across the whole integration suite. A test opts in
through `pinnedRuntimes` in `tools/build-test-matrix.mjs`, which replaces the
`tested` cross-product for that test with an explicit list of
`{ product, version }` runtimes; `terraformOnly` marks tests that can never run
under OpenTofu. Unit tests in packages tagged `unit-test:terraform` also run
once under OpenTofu (`pr-unit.yml`).

Running under OpenTofu exercises the CLI, not a project that _targets_
OpenTofu. Code that resolves registries from `targetVersions` only takes its
OpenTofu path when the project declares it, so cover that with a fixture that
sets `targetVersions` — see `typescript/opentofu-target`.

### Local runs

Pick any locally installed binary per run:

```shell
# specific Terraform version (e.g. via mise/tfenv shims or a direct download)
TERRAFORM_BINARY_NAME=terraform1.6.5 npx jest --runInBand typescript/function-version-validation

# OpenTofu
TERRAFORM_BINARY_NAME=tofu npx jest --runInBand typescript/function-version-validation
```

Version-sensitive tests should detect the product/version themselves and
adapt their expectations instead of hardcoding one binary. Note that
synth-time validations are deliberately _not_ version-sensitive: they check
the project's declared `targetVersions` from cdktf.json and never execute a
binary — `typescript/function-version-validation/test.ts` demonstrates this
by running every synth with a nonexistent `TERRAFORM_BINARY_NAME` and driving
expectations purely through the declared targets.
