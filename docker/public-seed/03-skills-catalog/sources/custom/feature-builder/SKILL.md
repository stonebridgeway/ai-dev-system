---
name: feature-builder
description: Use when Codex needs to implement a new feature or product behavior in an existing codebase, especially when the work requires reading local architecture, reusing project patterns, adding tests, and verifying the result.
---

# Feature Builder

## Workflow

1. Read project guidance and relevant knowledge docs.
2. Locate existing patterns for similar features.
3. Choose the smallest implementation path that preserves architecture.
4. Implement the feature.
5. Add or update focused tests when behavior changes.
6. Run relevant lint, typecheck, test, build, or browser checks.
7. Report changed files and verification.

## Guardrails

- Reuse existing components and helpers.
- Avoid unrelated refactors.
- Do not add dependencies unless the benefit is clear.
- Keep user-facing behavior explicit and tested when possible.

## Verification

- Run the narrowest relevant test first, then the repository quality gate required by the changed surface.
- For visible behavior, verify the main workflow and one failure or empty state in the running application.

## Output

Report the behavior implemented, files changed, checks and evidence, compatibility decisions, and any remaining risk.
