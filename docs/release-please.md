# Release automation with release-please

This repo uses [release-please](https://github.com/googleapis/release-please) to
automate version bumps, `CHANGELOG.md` generation, git tags and GitHub releases
from [Conventional Commits](https://www.conventionalcommits.org/).

It is configured **additively**: release-please owns _versioning and the release
PR_, while the existing publishing pipeline (`release.yml` + `release-publish.yml`,
plus the Sentry release tracking and the `@next` prerelease channel) is left
untouched and keys off `package.json` as it always has.

## Versioning model

This is a **locked-version JSII monorepo**: every package ships at the single
root version. In git the sub-package `package.json`s stay at `0.0.0` and are
aligned at build time by `tools/align-version.sh` (`lerna version`). Therefore
release-please manages a **single root release** (the `"."` package in
`release-please-config.json`) — not independent per-package versions.

Tags are `v<version>` (`include-component-in-tag: false`), matching the existing
convention used by `tools/release-github.sh`.

## Files

| File                                   | Purpose                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `release-please-config.json`           | Release config — release-type `node`, single `"."` package, changelog sections. |
| `.release-please-manifest.json`        | Source of truth for the last released version (`0.23.2`).                       |
| `.github/workflows/release-please.yml` | Runs release-please on every push to `main`.                                    |

## How it works

1. Conventional commits land on `main`.
2. `release-please.yml` runs and keeps **one release PR** open, rebasing it as
   more commits land. The PR bumps the root `package.json` and prepends the new
   section to `CHANGELOG.md`. `fix:` → patch, `feat:` → minor, `!`/
   `BREAKING CHANGE` → major.
3. When you're ready to cut a release, **merge the release PR**. release-please
   then creates the `v<version>` tag and the GitHub release.
4. The merge is a push to `main`, which triggers `release.yml`. Its stable
   channel sees a version that Sentry reports as `unreleased`, builds the
   multi-language dist and publishes to npm, PyPI, Maven, NuGet and Go via
   `release-publish.yml`. `tools/release-github.sh` no-ops because
   release-please already created the GitHub release.

Normal (non-release) pushes to `main` keep publishing the `@next` prerelease
channel exactly as before — release-please only touches the release PR.

## Required GitHub App: "CDKTN maintainers"

The workflow mints a short-lived token from the **CDKTN maintainers** GitHub App
instead of using `GITHUB_TOKEN`, because PRs/branches authored by `GITHUB_TOKEN`
do **not** trigger downstream workflows (the release PR's CI would never run).

The App must be **installed on this repository** with these permissions:

- **Contents: Read & write** — create the release branch, commit the version +
  `CHANGELOG.md` bump, create the tag and the GitHub release.
- **Pull requests: Read & write** — open / update / rebase the release PR.

Store its credentials as repository (or org) secrets:

- `CDKTN_MAINTAINERS_APP_ID`
- `CDKTN_MAINTAINERS_APP_PRIVATE_KEY`

If `main` is protected, allow the App to push the release branch and open PRs
(and, if "require status checks" blocks the bot, allow it to bypass or ensure
the release PR's checks can pass).

## First run / bootstrap

`bootstrap-sha` in the config pins the commit from which the **first** release PR
collects changes, so history before the release-please setup is not re-scanned
into the changelog. It is ignored once the first release PR exists and can then
be removed. The manifest is seeded with the current released version `0.23.2`.

## Migrating fully off `standard-version` (future)

`standard-version` (`yarn release`, `prepare-release`, `prepare-next-release`)
still drives the version in `package.json` for the `@next` channel. Once
release-please is trusted for stable releases, a follow-up can:

- replace the `@next` bump with a release-please [prerelease/snapshot] setup, and
- retire `tools/release-github.sh` (release-please creates the GitHub release).

These are intentionally **out of scope** for this additive setup.
