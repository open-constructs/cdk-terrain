# Tasks Index: CDKTN Package Rename (Release 1)

Beads Issue Graph Index into the tasks and phases for this feature implementation.
This index does **not contain tasks directly**—those are fully managed through Beads CLI.

## Feature Tracking

- **Beads Epic ID**: `core-x3d`
- **User Stories Source**: `specs/001-cdktn-package-rename/spec.md`
- **Research Inputs**: `specs/001-cdktn-package-rename/research.md`
- **Planning Details**: `specs/001-cdktn-package-rename/plan.md`
- **Data Model**: `specs/001-cdktn-package-rename/data-model.md`
- **Migration Guide**: `specs/001-cdktn-package-rename/quickstart.md`

## Beads Query Hints

Use the `bd` CLI to query and manipulate the issue graph:

```bash
# Find all open tasks for this feature
bd list --label "spec:001-cdktn-package-rename" --status open -n 10

# Find ready tasks to implement
bd ready --label "spec:001-cdktn-package-rename" -n 5

# See dependencies for the epic
bd dep tree core-x3d

# View issues by phase
bd list --label "phase:foundational" --label "spec:001-cdktn-package-rename"

# View issues by user story
bd list --label "story:US1" --label "spec:001-cdktn-package-rename"

# View issues by component
bd list --label "component:provider-generator" --label "spec:001-cdktn-package-rename"
```

## Tasks and Phases Structure

This feature follows Beads' 2-level graph structure:

- **Epic**: `core-x3d` → CDKTN Package Rename (Release 1)
- **Phases**: Beads issues of type `feature`, child of the epic
- **Tasks**: Issues of type `task`, children of each feature issue (phase)

### Phase Overview

| Phase                   | Beads ID   | Description                                           | Priority |
| ----------------------- | ---------- | ----------------------------------------------------- | -------- |
| Setup                   | `core-1q9` | Project initialization and build config               | P1       |
| Foundational            | `core-atg` | Core package renames (BLOCKS all user stories)        | P1       |
| US1: New User Bootstrap | `core-hu1` | New user can init project with cdktn                  | P1       |
| US2: Migration          | `core-w6w` | Existing user can migrate from cdktf                  | P1       |
| US3: Prebuilt Providers | `core-at3` | Developer uses prebuilt providers                     | P2       |
| US4: Local Providers    | `core-86i` | Developer generates local providers (clean migration) | P1       |
| US5: HCL Convert        | `core-kki` | Developer converts HCL to CDK                         | P3       |
| Polish & Validation     | `core-az4` | Final validation and cross-cutting concerns           | P2       |

## Convention Summary

| Type    | Description                  | Labels                                 |
| ------- | ---------------------------- | -------------------------------------- |
| epic    | Full feature epic            | `spec:001-cdktn-package-rename`        |
| feature | Implementation phase / story | `phase:<name>`, `story:<US#>`          |
| task    | Implementation task          | `component:<x>`, `requirement:<fr-id>` |

## Phase Details

### Phase 1: Setup (`core-1q9`)

**Purpose**: Project initialization and build system preparation

```bash
bd list --label "phase:setup" --label "spec:001-cdktn-package-rename" --type task
```

Tasks: 3 | Ready: 3

### Phase 2: Foundational (`core-atg`)

**Purpose**: Core package renames - MUST complete before ANY user story

**CRITICAL**: All 9 packages renamed, all cross-package imports updated

```bash
bd list --label "phase:foundational" --label "spec:001-cdktn-package-rename" --type task
```

Tasks: 10 | Blocked by: Phase 1 completion

### Phase 3: User Story 1 - New User Bootstraps Project (`core-hu1`) 🎯 MVP

**Goal**: New developer can start fresh cdktn project in any published language

**Independent Test**: `npx cdktn-cli init --template typescript` creates working project

```bash
bd list --label "story:US1" --label "spec:001-cdktn-package-rename" --type task
```

Tasks: 8 | Blocked by: Foundational phase

### Phase 4: User Story 2 - Existing User Migrates (`core-w6w`)

**Goal**: Existing CDKTF user can migrate to cdktn preserving Terraform state

**Independent Test**: Updated project produces identical synthesized output

```bash
bd list --label "story:US2" --label "spec:001-cdktn-package-rename" --type task
```

Tasks: 6 | Blocked by: Foundational phase

### Phase 5: User Story 3 - Prebuilt Providers (`core-at3`)

**Goal**: Verify cdktn works correctly with provider packages

**Independent Test**: Provider package synthesizes correctly with cdktn stack

```bash
bd list --label "story:US3" --label "spec:001-cdktn-package-rename" --type task
```

Tasks: 3 | Blocked by: Foundational phase

### Phase 6: User Story 4 - Local Providers (`core-86i`)

**Goal**: `cdktn get` generates providers with cdktn imports (clean migration path)

**Independent Test**: Generated code has zero cdktf references

```bash
bd list --label "story:US4" --label "spec:001-cdktn-package-rename" --type task
```

Tasks: 3 | Blocked by: Foundational phase

### Phase 7: User Story 5 - HCL Convert (`core-kki`)

**Goal**: `cdktn convert` generates CDK code with cdktn imports

**Independent Test**: Converted HCL produces compilable cdktn code

```bash
bd list --label "story:US5" --label "spec:001-cdktn-package-rename" --type task
```

Tasks: 2 | Blocked by: Foundational phase

### Phase 8: Polish & Validation (`core-az4`)

**Purpose**: Final validation, testing, and cross-cutting concerns

```bash
bd list --label "phase:polish" --label "spec:001-cdktn-package-rename" --type task
```

Tasks: 8 | Blocked by: US1, US2, US4

## Dependencies & Execution Order

### Phase Dependencies

```
Setup (Phase 1)
    ↓ blocks
Foundational (Phase 2)
    ↓ blocks (ALL user stories)
    ├── US1: New User Bootstrap (Phase 3) ──┐
    ├── US2: Migration (Phase 4) ───────────┼──→ Polish (Phase 8)
    ├── US3: Prebuilt Providers (Phase 5)   │
    ├── US4: Local Providers (Phase 6) ─────┘
    └── US5: HCL Convert (Phase 7)
```

### Parallel Execution Opportunities

After Foundational phase completes, the following can run in parallel:

- US1 (New User Bootstrap)
- US2 (Migration)
- US3 (Prebuilt Providers)
- US4 (Local Providers)
- US5 (HCL Convert)

Within each user story, tasks should follow dependency order. Use `bd ready` to find parallelizable tasks.

## MVP Scope

**Suggested MVP**: User Stories 1 + 4 (New User Bootstrap + Local Providers)

This enables:

1. New users can start fresh cdktn projects
2. Clean migration path via `cdktn get` (zero cdktf dependencies)

**MVP Tasks**:

```bash
bd list --label "story:US1" --label "spec:001-cdktn-package-rename" --type task
bd list --label "story:US4" --label "spec:001-cdktn-package-rename" --type task
```

## Implementation Strategy

1. **Complete Setup phase** - Update build configs (3 tasks, parallelizable)
2. **Complete Foundational phase** - Rename all 9 packages (10 tasks, mostly parallel then final sweep)
3. **Implement P1 User Stories in parallel**:
   - US1: Template updates for new user experience
   - US2: Migration command implementation
   - US4: Provider generator updates
4. **Implement P2/P3 User Stories** - US3, US5 can follow
5. **Polish phase** - Testing, validation, examples

## Task Summary

| Category          | Count |
| ----------------- | ----- |
| Total Tasks       | 43    |
| P1 (Critical)     | 31    |
| P2 (Normal)       | 9     |
| P3 (Low)          | 3     |
| Currently Ready   | 39    |
| Currently Blocked | 13    |

### Tasks by User Story

| Story                    | Tasks | Priority |
| ------------------------ | ----- | -------- |
| US1 (New User Bootstrap) | 8     | P1       |
| US2 (Migration)          | 6     | P1       |
| US3 (Prebuilt Providers) | 3     | P2       |
| US4 (Local Providers)    | 3     | P1       |
| US5 (HCL Convert)        | 2     | P3       |

## Agent Execution Flow

MCP agents and AI workflows should:

1. **Assume `bd init` already done** by `specify init`
2. **Use `bd ready`** to find next available tasks
3. **Update task status** as work progresses
4. **Use `bd close`** with reason when completing tasks

```bash
# Get next ready task
bd ready --label "spec:001-cdktn-package-rename" -n 1

# Start working on a task
bd update <task-id> --status in-progress

# Complete a task
bd close <task-id> --reason "Completed: package.json updated, tests pass"
```

---

> This file is intentionally light and index-only. Implementation data lives in Beads. Update this file only to point humans and agents to canonical query paths and feature references.
