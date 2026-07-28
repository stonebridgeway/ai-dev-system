# Project Agent Standards

These standards should appear in every project-level `AGENTS.md` either directly or through `bootstrap_project`.

## Startup

1. Read root `AGENTS.md`.
2. Read `.ai-dev/project-map.md`.
3. Read `.ai-dev/quality-gate.md`.
4. Inspect nearby code before editing.
5. Use MCP for skills, knowledge, and auto-command routing.

## Scope Control

- Keep changes scoped to the requested behavior.
- Prefer existing architecture, naming, components, utilities, and test style.
- Do not do unrelated refactors, formatting churn, dependency swaps, or file moves.
- Preserve user changes and never reset unrelated work.
- Do not introduce dependencies unless the benefit is clear and the project pattern supports it.

## Code Style

- Match the repository's formatting, naming, module boundaries, and error-handling style.
- Use existing helpers and abstractions before adding new ones.
- Add an abstraction only when it removes real complexity or matches an established local pattern.
- Keep edits small and reviewable.
- Do not leave TODO placeholders, dead code, debug output, or partial implementations in final work.

## Testing

- Add or update tests for bug fixes, shared logic, data transformations, and user-visible behavior.
- Prefer focused regression tests for bugs.
- Broaden tests when touching shared contracts, build config, auth, persistence, queues, or user-facing flows.
- Do not weaken or delete tests to make a failure disappear.

## Required Checks

- Always read `.ai-dev/quality-gate.md` before final verification.
- Run the narrowest relevant check first.
- Run broader checks when touching shared behavior, build config, routing, auth, persistence, queues, or UI foundations.
- If a check cannot run, report the exact reason.
- Do not mark work complete while relevant checks are failing.

## Frontend Quality Gate

- Verify responsive layout on desktop and mobile when UI changes are visible.
- Check loading, empty, error, hover, focus, and disabled states when touched.
- Ensure text does not overflow buttons, tables, cards, or navigation.
- Reuse the existing design system before adding one-off UI.
- For meaningful visual work, inspect the app in a browser or screenshot and report that verification.

## Safety

- Do not commit secrets, tokens, API keys, private credentials, or local-only config.
- Treat auth, permissions, payments, user data, migrations, queues, and external side effects as high-risk.
- Do not run scripts that may send real messages, call paid APIs, publish content, or mutate production data without explicit approval.

## Final Response

Always report:

- changed files;
- checks run and results;
- skipped checks and reasons;
- remaining risk or follow-up work.
