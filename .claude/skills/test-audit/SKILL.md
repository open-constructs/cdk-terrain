---
name: test-audit
description: "Invoke whenever writing, changing, reviewing, or sweeping tests. Authoring gate for new tests plus audit workflow for low-value, implementation-coupled, or duplicative tests and the test-only production seams they demand."
---

# Test Audit

Three modes, one value bar. Authoring mode gates every new or changed test at
write time. Audit mode runs focused sweeps of tests that re-assert source,
duplicate stronger proof, couple behavior to implementation, or keep test-only
production seams alive. Continue broad audits as separate coherent follow-up
PRs; optimize for confidence, not deletion count. Campaign mode prunes one
whole subsystem's test surface (one package, or one owner area of the
integration suite); before starting one, read [CAMPAIGN.md](CAMPAIGN.md).

## Test tiers

Every contract has one primary owning tier. Know the tiers before judging a
test; [TIERS.md](TIERS.md) has where each lives, how CI routes it, what a
green run does and does not prove, and the commands.

- Static gates (build, `pnpm package`, lint): types, the JSII-compilable API,
  packaging for every language.
- Unit: one package's behavior through its public entry point. Four packages
  also run once per Terraform and OpenTofu binary.
- Integration (`test/<language>/<scenario>`): the packaged CLI and library
  against a real binary, and each language binding installing and running.
- Provider integration and examples: generation, type-checking and synthesis
  against real provider schemas.

## Authoring gate

Before adding any test, answer five questions; a missing answer means do not
add it yet:

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail?
3. Which [tier](#test-tiers) owns it? Use the cheapest tier that can observe
   the failure. A behavior of the Node CLI or of core synthesis belongs in a
   unit test. An integration test needs a risk only the packaged artifact, a
   real binary, or a language binding can show.
4. Why does existing coverage not already catch that failure? Each contract has
   one primary test owner at the strongest boundary; another tier or language
   needs its own distinct risk. Prefer extending a table-driven case or shared
   fixture over a near-duplicate test; consolidate duplicated setup in the same
   change.
5. Does it need a production seam (export, flag, context key, injection
   parameter) that no production caller needs? If yes, move the test to the
   real boundary instead.

Then check the test against every [junk pattern](#junk-patterns); a match fails
the gate unless the [retention bar](#retention-bar) names the contract it
independently guards. A test that would break under behavior-preserving
refactoring is asserting implementation, not behavior; rewrite it at the
owning boundary before landing it.

Bug regression tests must fail on the pre-fix code for the intended reason and
pass after the owner-boundary repair. A regression test that never demonstrably
failed proves the mock, not the fix. One regression at the owner boundary
covers the bug; do not replay the same scenario at every tier or in every
language it crosses.

A feature flag needs a test for the default (disabled) case and one for the
enabled case. `Testing.app` enables every future flag, so the disabled case
must pass `enableFutureFlags: false`.

The project principles ask for tests with every change and for coverage that
does not drop. Meet them with tests that pass this gate. Coverage is reported
but never thresholded, and the principles rank YAGNI and KISS above coverage;
a test added only to move the number fails the gate.

## Snapshots

Much of this repo's proof is a snapshot of synthesized JSON, rendered HCL,
generated bindings, or converted code. A snapshot is an expected value produced
by the code under test, so it is a contract only on these terms:

- The fixture isolates one shape and the entry is small enough to review line
  by line. Then the reviewed text is the golden file, and it is the contract
  when that text is what users receive.
- A test named for a property (shard count, a skipped attribute, an escaped
  description) asserts that property directly. An entry too large to review,
  or a whole stack re-snapshotted to check one string, proves only that the
  output did not change.
- Update only the snapshot file you meant to change. The repository-wide
  update commands (`pnpm test:update`, `pnpm integration:update`) are for a
  deliberate migration, where every changed entry is still reviewed.

## Junk patterns

The shared checklist for both modes: the authoring gate rejects a new test that
matches one, and audits hunt for existing tests that do.

- assertion-free coverage probes, and "does not throw" as the only assertion
  where an output or error text is observable;
- assertions that cannot run or cannot fail: an `expect` inside a loop over an
  empty match, an un-awaited `expect(...).rejects`, a truthiness check on a
  function reference, a negative `toContain` on a string the code never emits,
  an inequality between values that differ by construction;
- self-comparisons and identity copiers, such as building an object literal and
  asserting its own fields;
- copied fixtures, inventories, manifests, or export lists;
- exact source, import, or string greps;
- private predicate or call-shape tests duplicated at real boundaries, such as
  `toHaveBeenCalledWith` on a mocked internal when a temp directory or a
  synthesized stack would prove the outcome;
- duplicate invocations of the same contract, including byte-identical
  snapshot entries under two titles;
- per-language or per-tier replays of a contract that one owner already proves:
  a Node CLI flag asserted in all five languages, or an integration snapshot of
  output a core unit test already pins;
- tests whose only purpose is preserving test-only exports, context keys,
  environment variables, or injection parameters;
- helpers defined in the test file and then tested there;
- dead production code whose only callers are tests;
- expected values produced by the helper or renderer under test, outside the
  [snapshot terms](#snapshots). Where the exact value is the contract, pin a
  known answer from an independent source;
- mocks that implement the asserted behavior, or one identical mock standing in
  for different APIs;
- runner-output checks that pass when no test ran, such as matching only `PASS`
  or `BUILD SUCCESSFUL`;
- negative controls that pass for an unrelated reason, such as a rejection from
  a different guard or one the production path never reaches;
- names or fixtures that promise more than the input exercises, such as
  "compiles to TypeScript" on a test that compiles nothing;
- standing `describe.skip`, `it.skip`, `it.todo`, and platform-gated tests on a
  platform CI never runs: repair and enable them, or delete them. A skipped
  integration file still costs CI jobs.

## Value bar

Tests justify their maintenance cost by protecting behavior, a credible
regression, or an independently meaningful contract. In an audit, an existing
test that must change for behavior-preserving source reorganization is suspect,
not automatically deletable; the authoring gate still rejects new ones.

Before judging a candidate, read the complete test and production owner, its
entry point, callers, callees, sibling implementations, overlapping tests in
other tiers, CI routing, and relevant history. Read `CLAUDE.md`, the Tests
section of `CONTRIBUTING.md`, and `test/Readme.md` first. When the test claims
behavior of Terraform, OpenTofu, jsii, or a provider schema, inspect that
dependency's source, types, or real output directly.

## Discovery

Keep discovery read-only and report evidence before editing. For broad scope,
run parallel discovery lanes when available:

- core library (`packages/cdktn`), with `src/testing/**` as its own area;
- CLI (`packages/cdktn-cli`, `packages/@cdktn/cli-core`);
- generation and conversion (`@cdktn/provider-generator`,
  `@cdktn/provider-schema`, `@cdktn/hcl2cdk`, `@cdktn/hcl2json`,
  `@cdktn/hcl-tools`, `@cdktn/commons`);
- integration suite, provider tests, and examples (`test/`, `examples/`);
- a cross-cutting pattern sweep, including unit-versus-integration overlap.

Outside campaign mode, prefer a few high-confidence candidates over a large
speculative inventory. Hunt for the [junk patterns](#junk-patterns).

## Retention bar

Keep a test when it independently enforces a synthesized JSON, HCL, or
manifest shape; a logical ID, asset hash, or staging path; a name preserved
across the cdktf to cdktn rename (symbols, `__cdktf_*`, `cdktf.json`,
`CDKTF_*`, `@cdktf/*` provider naming); a feature flag's disabled or enabled
behavior; generated provider or function binding text and the JSII constraints
on it; HCL conversion or parse output; a config key, CLI flag, exit code, or
user-facing error text; or a package, release, or security contract.

Three of this repo's contracts need a judgement call:

- Terraform and OpenTofu version compatibility. The same test running on
  several binaries is matrix coverage, not duplication.
- Language bindings installing, compiling and running. A scenario repeated in
  five languages is the contract when the program, package manager, or compile
  step differs, and a replay when only the Node CLI is exercised.
- `src/testing/**` (`Testing`, the matchers, the adapters) is shipped public
  API in every language. Its tests are product tests and its options are not
  test-only seams.

Also keep:

- call ordering when order is observable behavior;
- regressions with a credible failure mode;
- failure and transient-error paths that a higher tier cannot reproduce;
- source inspection when it is the cheapest independent guard: it fails when
  the contract changes (the user-facing key, byte, or path) and survives an
  identifier-only refactor;
- a retained test that fails on the baseline: treat it as a possible product
  bug, reproduce it, and repair the owner rather than deleting it.

Static or slow is not a deletion reason. A test that resembles implementation
may still be the independent contract; prove otherwise before removing it.

## Candidate evidence

Record every field below before editing. A missing field means the candidate is
not ready for deletion:

- exact test name and location;
- its tier, and the matrix cells (binary, language, HCL mode) it runs in;
- what failure it can actually detect;
- non-test callers of the covered production or support seam, from `git grep`.
  No tool reports unused exports here; knip checks dependencies only;
- stronger remaining owner-boundary proof, or why no proof is needed;
- relevant history and the reason the test or seam exists;
- production, snapshot, fixture, or test-support deletion unlocked;
- risk and the focused validation command.

## Edit shape

Choose one coherent owner-boundary batch, reviewable in under 30 minutes. Keep
it apart from feature and fix PRs; a bug fix does not carry surrounding test
cleanup.

Delete obsolete test-only exports, context keys, wrappers, and dead production
paths instead of preserving aliases. Removing anything from the public JSII
API, including `Testing` options, is a breaking change in every language and
is not audit cleanup; report it as a follow-up. Move retained regressions to
their canonical owners. Delete the snapshot entries and fixtures a removed
test leaves behind.

Prefer net-negative production LOC. Do not add replacement tests that restate
the same implementation, and do not convert uncertain candidates into cleanup
to increase deletion counts.

## Validation

Commands for every step are in [TIERS.md](TIERS.md).

1. Run the smallest owner and sibling tests through Nx, so that the build is
   current.
2. Confirm in the output that each suite ran rather than skipped, and say
   which matrix cells (binary, language, HCL mode) you ran. CI covers the
   other cells, but it can skip a dist-gated suite too; TIERS.md says when.
3. For a removed grep or call-shape assertion, run the real path that owns the
   contract: the synth, the generation, or the CLI command.
4. A changed snapshot is a behavior change. Explain every changed entry by the
   source change before accepting it.
5. Run targeted formatting and lint, then `git diff --check`.
6. List the projects the PR will test. When the change deletes, renames, or
   adds an integration scenario or an example, run the matching matrix
   builder.
7. Inspect `git diff --numstat`; report production and tooling separately from
   tests, snapshots, and fixtures.
8. Review the final diff with `/code-review` when it is available.

## Landing and continuation

Commit, push, open a PR, or land only when authorized. Title a pure test change
`test(<scope>):`, and use `refactor(<scope>):` when production seams are
removed with it; the scope is the owning package's (`lib`, `cli`,
`provider-generator`, `hcl2cdk`, `hcl2json`) or `tests` for the integration
suite and harness. Never label away the tier the change touches. Land one
coherent PR at a time; after landing, refresh from current `main` and rerun
read-only discovery for the next high-confidence batch.

## Handoff

Report:

- root cause and removed low-value categories;
- production owner simplifications;
- retained false positives and why they remain valuable;
- focused and full proof actually run, by tier and binary, and what was left
  to CI;
- production versus test, snapshot, and fixture LOC;
- PR and merge state;
- named follow-ups, including contracts found with no test owner.
