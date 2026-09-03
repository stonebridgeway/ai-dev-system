---
name: feature-builder
description: Use when Codex needs to implement a new feature or product behavior in an existing codebase, especially when the work requires reading local architecture, reusing project patterns, adding tests, and verifying the result.
---

# Feature Builder

## Workflow

1. Read project guidance and relevant knowledge docs.
2. Locate existing patterns for similar features.
3. Define the observable behavior, public seam, and an expectation derived independently from the implementation.
4. Choose the smallest implementation path that preserves architecture.
5. When the behavior is testable at that seam, work in vertical red-green slices: one failing test, the minimum implementation that passes it, then the next slice.
6. Refactor only after the behavior is green; do not mix speculative cleanup into the implementation loop.
7. Run relevant lint, typecheck, test, build, or browser checks.
8. Report changed files and verification.

## Guardrails

- Reuse existing components and helpers.
- Avoid unrelated refactors.
- Do not add dependencies unless the benefit is clear.
- Test behavior through public interfaces. Mock only true system boundaries such as remote APIs, time, randomness, or unavoidable I/O.
- Avoid tautological expectations that reproduce the implementation logic inside the test.
- Keep user-facing behavior explicit and tested when possible.

## Verification

- Run the narrowest relevant test first, then the repository quality gate required by the changed surface.
- For visible behavior, verify the main workflow and one failure or empty state in the running application.

## Output

Report the behavior implemented, files changed, checks and evidence, compatibility decisions, and any remaining risk.
