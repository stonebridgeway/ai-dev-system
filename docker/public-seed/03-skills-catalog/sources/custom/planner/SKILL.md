---
name: planner
description: Use when begin_task reports plan_required, for complex features, refactors, migrations, or architectural changes, to produce an implementation plan with phases, exact files, dependencies, risks, tests, and rollback before broad code changes, recorded with plan_task.
---

# Planner

Plan before executing. A plan is specific (file paths, function names), incremental (each phase verifiable and mergeable on its own), and honest about risk.

## Workflow

1. Requirements: restate the goal, list observable success criteria, assumptions, and constraints; ask when the request is ambiguous instead of guessing.
2. Architecture review: read the compiled context pack, `.ai-dev/project-map.md`, recent decisions (`list_decisions`), and similar existing implementations; reuse patterns before inventing new ones.
3. Step breakdown: for every step record the file, the action, why it is needed, its dependencies, and its risk (low/medium/high).
4. Phasing: Phase 1 minimum viable slice, Phase 2 complete happy path, Phase 3 edge cases and polish, Phase 4 optimization; each phase independently verifiable.
5. Testing strategy: which unit, integration, and end-to-end tests prove each phase; which existing tests must keep passing.
6. Risks and rollback: name what can go wrong (out-of-order events, partial migrations, stale caches) with a mitigation each, and a one-paragraph rollback.
7. Record the plan with `plan_task`; keep `checkpoint_task` summaries aligned with the phases and re-record the plan when scope changes materially.

## Plan format

Overview (2-3 sentences), Requirements, Implementation Steps grouped by phase (step, file, why, dependencies, risk), Testing Strategy, Risks & Mitigations, Rollback, Open Questions, Success Criteria as checkboxes. `plan_status` returns a template with these fields.

## Red flags

Steps without file paths, phases that cannot be delivered independently, no testing strategy, functions over 50 lines or files over 800 lines in the design, missing error handling, hardcoded values, and plans that rewrite instead of extend.

## Guardrails

- Do not start broad implementation on a plan-required task before `plan_task` succeeds; small experiments to validate an assumption are fine.
- Do not plan architecture changes the task did not ask for; prefer extending existing structure.
- Never include secrets, credentials, or production data in a plan.

## Output

The recorded plan path, the phase to start with, the acceptance criteria touched, and the open questions the user must answer.

## Verification

The plan is complete when every step names a file and a test, every high-risk step has a mitigation, and `plan_status` shows the plan criterion met.
