# Test tiers and commands

Reference for [SKILL.md](SKILL.md): where each tier lives, what it owns, how CI
routes it, and the commands that run it. This is the part that changes when
workflows, binaries, or matrix builders change; check it against
`.github/workflows/` when in doubt.

## Tiers

| Tier                 | Where                                                                                                            | Owns                                                                                                                                              | CI routing                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Static gates         | `build` (tsc, jsii), `pnpm package`, eslint, prettier, knip                                                      | types, JSII-compilable API, packaging for all languages, formatting, dependency hygiene                                                           | always on PRs; labels cannot skip them                                                                                             |
| Unit                 | `cdktn-cli`, `@cdktn/commons`, `@cdktn/hcl2cdk`, `@cdktn/hcl2json`, `@cdktn/hcl-tools` (Nx tag `unit-test`)      | behavior of one package through its public entry point                                                                                            | PR: `nx affected`, one job, the image's default terraform                                                                          |
| Unit, binary matrix  | `cdktn`, `@cdktn/cli-core`, `@cdktn/provider-generator`, `@cdktn/provider-schema` (Nx tag `unit-test:terraform`) | the same, plus behavior that varies by Terraform or OpenTofu version                                                                              | PR: `nx affected` once per binary in the `pr-unit.yml` matrix; `main`: every package, Terraform only                               |
| Integration          | `test/<language>/<scenario>/test.ts`                                                                             | the packaged CLI and library, installed from `dist/`, against a real binary; and each language binding actually installing, compiling and running | every file, once per tested Terraform version, plus an HCL-mode run for files that use an HCL gate (`tools/build-test-matrix.mjs`) |
| Provider integration | `test/provider-tests`, one template stamped per key in `providers.json`                                          | `cdktn get` on real, large provider schemas; the only Windows coverage                                                                            | every provider, Linux and Windows                                                                                                  |
| Examples             | `examples/**` (`tools/build-example-matrix.mjs`)                                                                 | real-provider bindings type-check and synthesize in every language; the docs snippets compile                                                     | build and synth only; an example's own `test` target never runs in CI                                                              |

## What a green run proves

- Jest transpiles with swc and does not type-check. A type-shape assertion is
  the build's job, not a runtime test's.
- A PR runs unit tests only for affected projects. A change under `test/`,
  `tools/`, or `.github/` selects none. Integration, provider integration and
  examples always run in full unless a `ci/skip-*` or `ci/unit-only` label
  skips them.
- Suites wrapped in `describeIfDistExists` skip with only a warning when
  `dist/` is missing. `@cdktn/hcl2cdk` runs its synth legs only when `CI` is
  set, and its global setup needs `dist/` and a Terraform binary.
- Some `packages/cdktn` tests import `../lib`, the built output. Running jest
  directly without a build tests stale code; running through Nx builds first.
- The Nx cache does not key on `TERRAFORM_BINARY_NAME`. Pass `--skip-nx-cache`
  when rerunning a package against a different binary.
- The integration suite retries a failed test once, so one green run can hide
  a flake.
- Compiled `*.test.js` files are gitignored leftovers that never run. Search
  with `git ls-files` or `git grep`.

## Commands

Unit tests. The path is relative to the package, `-t` is a regular expression
on the test name, and Nx builds the dependency chain first. Projects are named
as in each `package.json`, such as `cdktn` or `@cdktn/cli-core`.

```bash
pnpm nx test <project> -- <path> -t "<name>" --coverage=false
TERRAFORM_BINARY_NAME=<binary> pnpm nx test <project> --skip-nx-cache -- <path>
pnpm nx run <project>:test:update -- <path>   # snapshots, one file
```

Dist-gated suites, `@cdktn/hcl2cdk`, and everything under `test/` need the
packaged artifacts first. For `@cdktn/hcl2cdk` also set `CI=1`.

```bash
pnpm package
pnpm integration:single <language>/<scenario>
SYNTH_HCL_OUTPUT=true pnpm integration:single <language>/<scenario>   # HCL run
cd test && pnpm edge:install                 # before edge scenarios
cd test && pnpm run test:provider <name>     # one provider test
```

Formatting, lint (warnings fail), and CI routing:

```bash
pnpm exec prettier --check <files>
pnpm nx lint <project>
pnpm exec nx show projects --affected --base=origin/main --head=HEAD
node tools/build-test-matrix.mjs             # integration; needs test/ deps
node tools/build-provider-test-matrix.mjs
node tools/build-example-matrix.mjs
```

The matrix builders throw on a stale pin. Run the matching one when a change
deletes, renames, or adds an integration scenario, a provider, or an example.
