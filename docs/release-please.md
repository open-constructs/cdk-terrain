# Release automation with release-please

This repo uses [release-please](https://github.com/googleapis/release-please) to
automate version bumps and `CHANGELOG.md` generation from
[Conventional Commits](https://www.conventionalcommits.org/), via an
always-open release PR. Git-tag and GitHub-release creation stay with the
existing `release.yml` pipeline (see [ownership](#who-owns-the-github-release-releaseyml)).

It is configured **additively**: release-please owns _versioning and the release
PR_, while the existing publishing pipeline (`release.yml` + `release-publish.yml`,
plus the Sentry release tracking and the `@next` prerelease channel) is left
untouched and keys off `package.json` as it always has.

## Versioning model

This is a **locked-version JSII monorepo**: every package ships at the single
root version. In git the sub-package `package.json`s stay at `0.0.0` and are
aligned at build time by `tools/align-version.mjs` (`nx release version`). Therefore
release-please manages a **single root release** (the `"."` package in
`release-please-config.json`) — not independent per-package versions.

Tags are `v<version>` (`include-component-in-tag: false`), matching the existing
convention used by `tools/release-github.sh`.

### Pre-1.0 bump policy

The project is intentionally still pre-`1.0.0` (alpha), so two flags keep
breaking changes from prematurely graduating it to `v1`:

```json
"bump-minor-pre-major": true,
"bump-patch-for-minor-pre-major": true
```

While the version is `0.x`, this yields:

| Commit                                 | Bump  | Example           |
| -------------------------------------- | ----- | ----------------- |
| `feat!` / `fix!` / `BREAKING CHANGE`   | minor | `0.23.3 → 0.24.0` |
| `feat` (non-breaking)                  | patch | `0.23.3 → 0.23.4` |
| `fix`                                  | patch | `0.23.3 → 0.23.4` |
| `chore` (e.g. dep bumps), `docs`, etc. | patch | rides along       |

Without these flags a single `feat!` would cut `1.0.0`. Remove them (or set to
`false`) when the project is ready to adopt standard semver and graduate to
`v1`. Note: as with standard release-please behavior, a `chore`/`docs`-only set
of commits won't _open_ a release PR on its own (only `feat`/`fix`/breaking do);
such changes are included as patch-level content in the next release.

## Files

| File                                   | Purpose                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `release-please-config.json`           | Release config — release-type `node`, single `"."` package, changelog sections. |
| `.release-please-manifest.json`        | Source of truth for the last released version (`0.23.3`).                       |
| `.github/workflows/release-please.yml` | Runs release-please on every push to `main` (release PR only, no tag/release).  |

## How it works

1. Conventional commits land on `main`.
2. `release-please.yml` runs and keeps **one release PR** open, rebasing it as
   more commits land. The PR bumps the root `package.json` and prepends the new
   section to `CHANGELOG.md`, following the pre-1.0 bump policy above
   (breaking → minor; `feat`/`fix` → patch).
3. When you're ready to cut a release, **merge the release PR**. release-please
   updates `.release-please-manifest.json` to the new version but, because
   `skip-github-release: true` is set, does **not** create the git tag or the
   GitHub release.
4. The merge is a push to `main`, which triggers `release.yml`. Its stable
   channel sees a version that Sentry reports as `unreleased`, runs the release
   tests, then **creates the `v<version>` tag and the GitHub release**
   (`release_github` → `tools/release-github.sh`) and publishes the
   multi-language dist to npm, PyPI, Maven, NuGet and Go via
   `release-publish.yml`.

Normal (non-release) pushes to `main` keep publishing the `@next` prerelease
channel exactly as before — release-please only touches the release PR.

## Who owns the GitHub release? (`release.yml`)

To avoid a double-create race, there is exactly **one** owner of git-tag and
GitHub-release creation: **`release.yml`'s `release_github` job**
(`tools/release-github.sh`), unchanged from before. release-please deliberately
opts out via `skip-github-release: true`, so it only maintains the release PR,
the version bump, `CHANGELOG.md` and the manifest.

This keeps the existing, test-gated release sequence intact (tag + release +
artifacts all happen together after the release tests pass) and requires no
changes to `release.yml`. release-please still tracks released versions through
`.release-please-manifest.json` (updated in the merged PR) and the `v<version>`
tags that `release.yml` creates — which match release-please's expected tag
pattern (`include-component-in-tag: false`).

> If you would rather make **release-please** the owner instead (it would create
> the tag + release immediately on merge, with its own generated notes), drop
> `skip-github-release` and remove the `release_github` job from `release.yml`.
> That is a deliberate, separate decision — see the migration note below.

## Release PR title and the PR linter

The release PR is itself linted by `pr-lint.yml`
(`amannn/action-semantic-pull-request`), so its title must be a valid
Conventional Commit. In manifest mode the title is driven by
**`group-pull-request-title-pattern`** (not `pull-request-title-pattern`), whose
default `chore: release ${branch}` would render as `chore: release main`. Both
patterns are therefore set to `chore(release): release v${version}` — `${version}`
is inherited from the root `.` package — producing e.g.
`chore(release): release v0.23.4`, which passes the linter (type `chore`, scope
`release`). If you change the linter's allowed types/scopes, keep these patterns
in sync.

## CI on the release PR

A release PR only changes `package.json`, `CHANGELOG.md` and the manifest, so it
doesn't need the heavy test suites. release-please applies the repo's CI-skip
labels to every release PR it opens via `extra-label`:

```json
"extra-label": "ci/skip-unit,ci/skip-examples,ci/skip-integration,ci/skip-provider-integration"
```

`extra-label` _adds_ these on top of the default `autorelease: pending` label
that release-please uses to identify/track its own PRs — unlike `label`, which
would _replace_ that identifier. With these applied, the gated suites
(`All Unit Tests`, `Integration`, `Provider Integration`, `Examples`) are
skipped while the fast always-on gates (build-and-package, lint, knip, prettier,
CodeQL, PR title lint, copyright) still run. Keep this list in sync with the
`ci/skip-*` labels honored in `pr.yml` if they change.

## Required GitHub App: "CDKTN maintainers"

The workflow mints a short-lived token from the **CDKTN maintainers** GitHub App
instead of using `GITHUB_TOKEN`, because PRs/branches authored by `GITHUB_TOKEN`
do **not** trigger downstream workflows (the release PR's CI would never run).

> **This App is net-new — it does not exist yet.** Today `cdktn-maintainers` is
> only a GitHub _team_ (CODEOWNERS owner, PR reviewer in `yarn-upgrade.yml`), and
> the existing PR automation authenticates with the `TERRAFORM_CDK_PUSH_GITHUB_TOKEN`
> PAT — not an App. You must create and install the App before this workflow can
> run. (Alternatively, that PAT could be reused instead of the App, but we chose
> the App for short-lived, scoped tokens.)

The App must be **installed on this repository** with these permissions:

- **Contents: Read & write** — create the release branch and commit the version +
  `CHANGELOG.md` bump. (Tag/release creation is owned by `release.yml`.)
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
be removed. The manifest is seeded with the current released version `0.23.3`
(release-please takes over from the `v0.23.3` release, PR #240), and
`bootstrap-sha` points at that release commit on `main`.

## Migrating fully off `standard-version` (future)

`standard-version` (`yarn release`, `prepare-release`, `prepare-next-release`)
still drives the version in `package.json` for the `@next` channel. Once
release-please is trusted for stable releases, a follow-up can:

- replace the `@next` bump with a release-please [prerelease/snapshot] setup, and
- flip release ownership to release-please (drop `skip-github-release` and remove
  the `release_github` job), retiring `tools/release-github.sh`.

These are intentionally **out of scope** for this additive setup.
