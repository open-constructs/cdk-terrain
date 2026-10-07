# Test-pruning campaign

Campaign mode prunes one subsystem's whole test surface: one package such as
`packages/@cdktn/provider-generator`, or one owner area of the integration
suite such as the provider commands across all five languages. The tiers,
value bar, retention bar, candidate evidence, and validation in
[SKILL.md](SKILL.md) apply to every lane. This file adds the order of work.
Each step ends on its completion criterion; do not start the next step early.

A campaign plans the whole subsystem once and lands it as a series of PRs, one
lane each, so that every PR stays reviewable in under 30 minutes. Keep the
ledger and plans in the campaign's working notes or the tracking issue, not in
the repository.

## 1. Baseline

Record the subsystem's test, snapshot, fixture, and support line counts and
every test file's result at a pinned `main` SHA. Run after `pnpm package`, and
with `CI=1` for `@cdktn/hcl2cdk`, so that dist-gated suites and synth legs
run. Record the binary used. For the integration suite, take the baseline from
a green CI run on that SHA rather than a full local run.

Keep three lists apart from the passes: baseline failures, tests that skipped
(statically, by a dist or capability gate, or by platform), and tests that
passed only on retry. A baseline failure is a bug report until proven stale.

Done when every in-scope test file has a recorded result that is a pass, a
failure, or a named skip.

## 2. Lanes and inventory

Split the surface into **lanes** along production owner boundaries, not file
prefixes. In `packages/cdktn` those are areas such as synthesis, HCL
rendering, tokens, functions, iterators, backends, modules, assets, validations
and target versions, and the shipped testing API. Include the subsystem's
cases in the other tiers: the integration scenarios, provider tests, and
examples that exercise the same owner, in every language.

Done when every test file, integration scenario, snapshot file, and fixture
the subsystem owns belongs to exactly one lane.

## 3. Read-only ledger per lane

Give each lane to its own read-only agent. The agent reads every assigned test
in full, including parameter tables and the snapshot entries the test writes.
It also reads the production owners and their entry points, callers, history,
and CI routing. Each test declaration goes into a written **ledger** with one
mark. An `it.each` is one declaration unless its rows need different marks;
then mark each row.

- `R`: retain, naming the contract and the bug it catches; a retained test that
  only moves to a better-named file stays `R` with the move noted;
- `F`: retain the contract but repair the assertion, such as an `expect` that
  never runs, an un-awaited rejection, or a snapshot standing in for a property
  the test is named for;
- `C`: consolidate, naming the owner that absorbs the assertion first: a sibling
  table case, a stronger boundary suite, a lower tier, or a single language;
- `D`: delete, naming the proof that remains, or why no contract exists.

Judge a test by its assertions, not its name. Mark a skipped test `F` or `D`,
never `R`.

Done when every declaration in the lane has a mark and an evidence line.

## 4. Layer plan per lane

Treat the per-test ledger as input, not as the edit list. A second read-only
pass, starting from the ledger, looks for the redundant **layer**: a contract
proven again in a second tier, in every language, or in a whole-output
snapshot around a targeted assertion. Name the **keeper** suite for each
contract. Prefer the real boundary (a synthesized stack, a generated file in a
temp directory, an HTTP mock under the real client) over a mocked
collaborator, and the cheapest tier that can still observe the failure.
Correct any ledger errors this pass finds.

Done when each lane plan names its retired files, its keeper per contract, the
assertions to carry into keepers, the snapshots and fixtures retired, and the
test-only production seams unlocked.

## 5. Cutover

Edit lane by lane, one PR per lane. Serialize changes to shared harnesses and
support files (`test/test-helper.ts`, `test/run-against-dist.mjs`, a package's
`test/helper/`, `jest.preset.js`) through one owner. With each lane, remove
the test-only production seams it unlocks: exports, context keys, environment
variables, and injection parameters.

Keep CI routing true to the files:

- unit tests are discovered by `**/*.test.ts` and the project's Nx tag; moving
  a test to another package moves it to that package's job and matrix;
- an integration scenario is its directory. Deleting or renaming one that is
  named in `pinnedRuntimes` or `terraformOnly` needs
  `tools/build-test-matrix.mjs` edited, and an HCL gate must stay visible to
  that script's source match;
- a provider test is a key in `test/provider-tests/providers.json`;
- an example is its `package.json`; `hclSmokeTargets` in
  `tools/build-example-matrix.mjs` and the runner sizing in `examples.yml`
  name some examples directly.

Remove obsolete snapshot entries and orphaned fixtures with the tests that
used them. Put durable test-ownership rules where contributors read them: the
Tests section of `CONTRIBUTING.md`, or `test/Readme.md` for the integration
suite, drawn from mistakes this campaign actually found.

Done when every lane plan is applied and each lane's keepers pass.

## 6. Preservation review

Before claiming a lane complete, have an independent reviewer compare its
deleted coverage against the keepers. They look for contracts that lost their
only proof, including a matrix cell: a binary, a language, HCL mode, or
Windows. They also look for new assertions that cannot fail.

For each restored contract, make one deliberate **mutation** of the production
owner and confirm the keeper goes red. Then restore the source byte for byte.
Rebuild before rerunning any test that imports built output.

Done when every reported gap is restored or rejected with source evidence, and
every restored contract has a caught mutation.

## 7. Product defects

A baseline failure that survives into a keeper is a bug report. Fix it at its
owner as a separate `fix(<scope>):` PR, and prove it through the real user
flow, with a **control** run that reverts the fix and shows the old behavior.
Record unrelated product discrepancies, and contracts found with no test owner
at all, as follow-ups instead of fixing them in the campaign.

Done when each repaired defect has a failing control and a passing candidate
on the same harness.

## 8. Reconcile and hand off

Campaigns outlive many `main` commits. Before each lane PR, refresh from
`main`. When `main` modified a file the campaign deleted, keep the deletion.
Port the new contract into the keeper instead, and confirm every new
regression `main` added still has a home. Rerun the subsystem's unit suite,
and let CI run the integration, provider, and example tiers on the refreshed
head; do not skip them with a label.

Hand off with the [SKILL.md](SKILL.md) report, plus:

- baseline and final test, snapshot, fixture, and support line counts, with
  production counted separately;
- lanes, retired layers, and keepers;
- skipped tests enabled or deleted;
- preservation gaps found and their mutations;
- product defects with control and candidate proof.
