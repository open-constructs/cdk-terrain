---
description: Generate an actionable, dependency-ordered tasks.md for the feature based on available design artifacts.
handoffs: 
  - label: Analyze For Consistency
    agent: specledger.analyze
    prompt: Run a project analysis for consistency
    send: true
  - label: Implement Project
    agent: specledger.implement
    prompt: Start the implementation in phases
    send: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Outline

1. **Setup**: Run `.specify/scripts/bash/check-prerequisites.sh --json` from repo root and parse FEATURE_DIR and AVAILABLE_DOCS list. All paths must be absolute. For single quotes in args like "I'm Groot", use escape syntax: e.g 'I'\''m Groot' (or double-quote if possible: "I'm Groot").

2. **Load design documents**: Read from FEATURE_DIR:
   - **Required**: plan.md (tech stack, libraries, structure), spec.md (user stories with priorities)
   - **Optional**: data-model.md (entities), contracts/ (API endpoints), research.md (decisions), quickstart.md (test scenarios)
   - Note: Not all projects have all documents. Generate tasks based on what's available.

3. *** Epic Creation**: From spec.md, create an epic using bd (beads) issue tracking for the feature using the feature name from plan.md.
   - Use the Beads CLI `bd create` to create one top-level issue of type `epic`
   - Title: pulled from plan.md or feature folder name
   - Description: summarize from plan.md + top of spec.md
   - Labels:

     - `spec:<feature-slug>` from feature folder name (e.g. `spec:006-authz-authn-rbac`)
     - `component:<primary-components>` from plan.md (e.g. `component:webapp`)
   - Let Beads auto-generate the ID (`id` parameter omitted)

4. **Execute task generation workflow using Beads Tools** (follow the template structure):
   - Load plan.md and extract tech stack, libraries, project structure
   - **Load spec.md and extract user stories with their priorities (P1, P2, P3, etc.)**
   - If data-model.md exists: Extract entities → map to user stories
   - If contracts/ exists: Each file → map endpoints to user stories
   - If research.md exists: Extract decisions → generate setup tasks
   - **Generate tasks ORGANIZED BY USER STORY using beads tools**:
     - Setup tasks (shared infrastructure needed by all stories)
     - **Foundational tasks (prerequisites that must complete before ANY user story can start)**
     - For each user story (in priority order P1, P2, P3...):
       - Group all tasks needed to complete JUST that story
       - Include models, services, endpoints, UI components specific to that story
       - Mark which tasks depends on others
       - If tests requested: Include tests specific to that story
     - Polish/Integration tasks (cross-cutting concerns)
   - **Tests are OPTIONAL**: Only generate test tasks if explicitly requested in the feature spec or user asks for TDD approach
   - Apply task rules:
     - Different files (no dependencies) = allow parallel
     - Same file = sequential requires dependency
     - If tests requested: Tests before implementation (TDD order)
   - Number tasks sequentially (T001, T002...)
   - Generate dependency graph showing user story completion order
   - Create parallel execution examples per user story
   - Validate task completeness (each user story has all needed tasks, independently testable)

5. **Generate tasks.md**: Use `.specify.specify/templates/tasks-template.md` as structure, fill with:
   - Correct feature name from plan.md
   - Correct Beads Epic ID and Labels
   - Correct User stories source, research input reference, planning details, data model and contracts paths (if available)
   This file does **not** list every task.
   - tasks.md acts as an index for querying Beads
   - For each phase and task described below also create corresponding use beads as shown in Phase 1 example
   - Phase 1: Setup tasks (project initialization) create a `feature`-type issue using the CLI `bd create` command.
      - Set `--parent <epic-id>` from the epic created above
      - Labels:
         - `phase:<phase-name>` (e.g. `phase:setup`, `phase:us1`, `phase:foundational`)
         - All carry the `spec:<feature-slug>` label
      - For each task, use `bd create` with `--type task` and `--parent <feature-id>`
      - Tasks must include:
         - `title` (short summary)
         - `description` Problem statement (WHY this matters) - immutable (what to implement, where, inputs/outputs)
         - `design` HOW to build, Which files, references (can change during work)
         - `acceptance` Acceptance: WHAT success looks like (stays stable)
         - `priority` (from story priority, 0=critical, 1=high, 2=normal, 3=low)
         - Labels:
            - `story:US1`, `story:US2`, etc. (mapped from spec.md)
            - `component:<area>` (e.g. `component:auth`, `component:db`)
            - `fr:<requirement-id>` if available
            - `spec:<feature-slug>`
   - Phase 2: Foundational tasks (blocking prerequisites for all user stories)
   - Phase 3+: One phase per user story (in priority order from spec.md)
     - Each phase includes: story goal, independent test criteria, tests (if requested), implementation tasks
     - Clear [Story] labels (US1, US2, US3...) for each task
     - Issue dependencies to identify parallelizable tasks within each story
     - Checkpoint markers after each story phase
   - Structure:
     - Top-level Epic ID + description
     - List of features (setup, foundational, stories)
     - Beads commands to filter each group:
       ```bash
       bd list --label "spec:<slug>" -n 10
       bd ready --label "spec:<slug>" -n 5
       ```
     - MVP and incremental delivery summary
     - Links back to spec.md and plan.md
   - Final Phase: Polish & cross-cutting concerns
   - Review Beads priorities for execution order
   - Review Beads ensuring clear file paths for each task
   - Review Beads task dependencies
   - Implementation strategy section (MVP first, incremental delivery)
   - Suggested MVP scope (typically just User Story 1)

6. **Report**: Beads tracks task execution and provides a summary:
   - Total tasks created
   - Breakdown per user story
   - Story testability (is each story independently verifiable?)
   - Parallel opportunities identified
   - Independent test criteria for each story
   - Suggested MVP (usually US1 or first P1 story)

Context for task generation: $ARGUMENTS

The tasks.md should be immediately executable - each task must be specific enough that an LLM can complete it without additional context. Particularly focus on breaking down by user story to enable independent implementation and testing against agreed interfaces and with clear instructions not to duplicate work (Provide assumptions based on task completion by other agents for parallel work).

## Task Generation Rules

**IMPORTANT**: Tests are optional. Only generate test tasks if the user explicitly requested testing or TDD approach in the feature specification.

**CRITICAL**: Tasks MUST be organized by user story to enable independent implementation and testing.

1. **From User Stories (spec.md)** - PRIMARY ORGANIZATION:
   - Each user story (P1, P2, P3...) gets its own phase (beads feature)
   - Map all related components to their story:
     - Models needed for that story
     - Services needed for that story
     - Endpoints/UI needed for that story
     - If tests requested: Tests specific to that story
   - Mark story dependencies (most stories should be independent)
   
2. **From Contracts**:
   - Map each contract/endpoint → to the user story it serves
   - If tests requested: Each contract → contract test task [P] before implementation in that story's phase
   
3. **From Data Model**:
   - Map each entity → to the user story(ies) that need it
   - If entity serves multiple stories: Put in earliest story or Setup phase
   - Relationships → service layer tasks in appropriate story phase
   
4. **From Setup/Infrastructure**:
   - Shared infrastructure → Setup phase (Phase 1)
   - Foundational/blocking tasks → Foundational phase (Phase 2)
     - Examples: Database schema setup, authentication framework, core libraries, base configurations
     - These MUST complete before any user story can be implemented
   - Story-specific setup → within that story's phase

5. **Ordering**:
   - Phase 1: Setup (project initialization)
   - Phase 2: Foundational (blocking prerequisites - must complete before user stories)
   - Phase 3+: User Stories in priority order (P1, P2, P3...)
     - Within each story: Tests (if requested) → Models → Services → Endpoints → Integration
   - Final Phase: Polish & Cross-Cutting Concerns
   - **DO NOT generate a linear checklist** — use Beads CLI to build a **task graph**
   - Each user story phase should be a complete, independently testable increment

## Label Conventions

| Label                | Purpose                             |
| -------------------- | ----------------------------------- |
| `spec:<slug>`        | All tasks in this feature spec      |
| `phase:<name>`       | Setup, US1, polish, etc.            |
| `story:US1`          | User story traceability             |
| `requirement:FR-001` | Functional requirement traceability |
| `component:<area>`   | Mapping to plan-defined modules     |
| `test:<type>`        | Test-related tasks                  |

## Example Beads CLI Calls

### Epic

```bash
bd create "Login Feature" --description "..." --type "epic" --labels "spec:006-login-auth,component:webapp" --priority 1
```

### Feature

```bash
bd create "Setup Phase" --description "..." --type "feature" --deps "parent-child:sl-epic-id" --labels "spec:006-login-auth,phase:setup,component:infra" --priority 1
```

**Use --design flag for:**
- Implementation approach decisions
- Architecture notes
- Trade-offs considered

**Use --acceptance flag for:**
- Definition of done
- Testing requirements
- Success metrics


### Task

```bash
bd create "Add React LoginForm" --description "..." --type "task" --deps "parent-child:sl-feature-id" --labels "spec:006-login-auth,story:US1,component:webapp" --priority 2
```

**Use --design flag for:**
- Implementation approach decisions
- HOW to build
- WHERE to build (which files, which modules to depend on)

**Use --acceptance flag for:**
- Definition of done
- Acceptance: WHAT success looks like (stays stable)
- Testing mechanism

**Use --notes flag for:**
- Additional context
- References to research or design docs
