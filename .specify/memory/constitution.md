<!--
  SYNC IMPACT REPORT
  ==================
  Version Change: 0.0.0 → 1.0.0 (MAJOR - initial constitution establishment)

  Added Principles:
  - I. YAGNI (You Aren't Gonna Need It)
  - II. KISS (Keep It Simple)
  - III. Minimal Viable Change
  - IV. Community Alignment
  - V. API Consistency
  - VI. Predictable Behavior
  - VII. Progressive Disclosure
  - VIII. Cross-Language Parity
  - IX. Test Coverage

  Added Sections:
  - Core Principles (Design Philosophy)
  - User Experience Standards
  - Quality Standards
  - Governance

  Templates Requiring Updates:
  - .specify/templates/plan-template.md: ✅ Compatible (Constitution Check section aligns)
  - .specify/templates/spec-template.md: ✅ Compatible (User scenarios structure supports principles)
  - .specify/templates/tasks-template.md: ✅ Compatible (Phase structure supports incremental delivery)

  Deferred Items: None
-->

# CDK Terrain Constitution

## Core Principles

### I. YAGNI (You Aren't Gonna Need It)

Only implement features when there is a current, concrete use case. Speculative abstractions, premature optimizations, and "future-proofing" are prohibited.

**Rules:**
- Every code addition MUST have an immediate, demonstrable need
- "We might need this later" is NOT a valid justification
- Remove unused code paths immediately; do not comment them out
- No configuration options for hypothetical scenarios
- Abstractions are earned through repetition (Rule of Three), not anticipated

**Rationale:** Unused code increases maintenance burden, cognitive load, and attack surface without providing value.

### II. KISS (Keep It Simple)

Prefer simple, readable solutions over clever ones. Minimize layers of abstraction. Code should be understandable by newcomers within minutes, not hours.

**Rules:**
- Choose boring technology over novel solutions
- Limit inheritance depth to 3 levels maximum
- Prefer composition over inheritance
- Avoid metaprogramming unless absolutely necessary
- If a solution requires extensive documentation to understand, simplify it
- Three similar lines of code is better than a premature abstraction

**Rationale:** Simple code is easier to debug, maintain, and extend. Complexity compounds over time.

### III. Minimal Viable Change

Each PR/change MUST do one thing well. Avoid bundling unrelated improvements.

**Rules:**
- Bug fixes do NOT include surrounding code cleanup
- Feature additions do NOT include unrelated refactoring
- One logical change per commit
- PRs should be reviewable in under 30 minutes
- If a change requires multiple reviewers with different expertise, split it

**Rationale:** Small, focused changes are easier to review, test, and revert if problems arise.

### IV. Community Alignment

Feature specifications MUST be reviewed and approved in collaboration with the community before implementation begins.

**Rules:**
- Major features require RFC or discussion issue before implementation
- Breaking changes MUST have a migration path documented
- Deprecations MUST include timeline and alternatives
- Community feedback periods MUST be respected before merging significant changes
- Maintainers MUST respond to community concerns with technical rationale

**Rationale:** CDK Terrain is a community fork; decisions should reflect community needs and consensus.

## User Experience Standards

### V. API Consistency

Similar operations MUST have similar interfaces across all supported languages.

**Rules:**
- Method names MUST follow language-specific conventions while preserving semantic meaning
- Parameter order MUST be consistent: required before optional, context before specifics
- Return types MUST be predictable: similar operations return similar structures
- Error types MUST be consistent within a domain
- Naming patterns established in one area MUST be followed in related areas

**Rationale:** Consistency reduces learning curve and prevents user errors.

### VI. Predictable Behavior

No surprises. Users MUST be able to reason about system behavior from documentation and type signatures.

**Rules:**
- Side effects MUST be documented in method signatures or names
- Default values MUST prioritize safety over convenience
- Error messages MUST be actionable: include what went wrong, why, and how to fix it
- Implicit behaviors (auto-imports, auto-conversions) MUST be minimal and documented
- Breaking changes MUST be detectable at compile/synth time, not runtime

**Rationale:** Predictable systems build user trust and reduce support burden.

### VII. Progressive Disclosure

Simple use cases require simple code. Advanced features available but not in the way.

**Rules:**
- Hello-world examples MUST work with minimal configuration
- Sensible defaults MUST cover 80% of use cases
- Advanced options available via explicit opt-in, not required understanding
- Documentation MUST present simple examples before advanced ones
- Configuration complexity MUST scale with use case complexity

**Rationale:** Low barrier to entry enables adoption; advanced features retain power users.

### VIII. Cross-Language Parity

Features available in one language MUST be available in all supported languages (TypeScript, Python, Go).

**Rules:**
- New features MUST NOT ship until available in all supported languages
- Language-specific limitations MUST be documented with workarounds
- Test coverage MUST be equivalent across all language bindings
- Examples MUST be provided in all supported languages
- Performance characteristics SHOULD be comparable across languages

**Rationale:** Users choose CDK Terrain for multi-language support; partial support defeats the purpose.

## Quality Standards

### IX. Test Coverage

All changes to core libraries require appropriate test coverage.

**Rules:**
- Core library changes MUST include unit tests
- Public API changes MUST include integration tests
- Bug fixes MUST include regression tests
- Test coverage percentage MUST NOT decrease
- Tests MUST be deterministic: no flaky tests allowed in CI

**Rationale:** Tests are the specification; untested code is undefined behavior.

## Governance

### Amendment Procedure

1. Propose changes via GitHub Discussion or RFC
2. Allow minimum 7 days for community feedback on significant changes
3. Maintainer approval required for all amendments
4. Migration plan required for any principle that affects existing code
5. Update all dependent templates and documentation before merging

### Versioning Policy

Constitution versions follow semantic versioning:
- **MAJOR**: Principle removal, redefinition, or backward-incompatible governance change
- **MINOR**: New principle added or existing principle materially expanded
- **PATCH**: Clarifications, typo fixes, non-semantic refinements

### Compliance Review

- All PRs MUST verify compliance with constitution principles
- Reviewers MUST cite relevant principles when requesting changes
- Complexity that appears to violate KISS or YAGNI MUST include written justification in PR description

### Principle Hierarchy

When principles conflict, apply in this order:
1. **YAGNI** - Do not build what is not needed
2. **KISS** - Keep the solution simple
3. **UX Consistency** - Maintain user experience standards
4. **Test Coverage** - Ensure quality through testing

Explicit override allowed with documented rationale approved by maintainer.

**Version**: 1.0.0 | **Ratified**: 2026-01-14 | **Last Amended**: 2026-01-14
