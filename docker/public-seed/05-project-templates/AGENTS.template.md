# AGENTS.md

Use this template for repositories that are not yet bootstrapped by `bootstrap_project`.

## Project

- Name:
- Root:
- Project map: `.ai-dev/project-map.md`
- Quality gate: `.ai-dev/quality-gate.md`

## Agent Startup

1. Read this file before changing code.
2. If any `.ai-dev` context file is missing, call `prepare_project` with `overwrite=false`.
3. Call `begin_task(project_path, task)` and read its bounded context pack plus at most three routed skills.
4. Record meaningful progress with `checkpoint_task`; call `verify_task` after edits and `complete_task` only with current passing evidence.
5. Use `match_auto_command` only as an optional shortcut for a recognised phrase.

## Commands

| Task | Command | Source |
| --- | --- | --- |
| Install |  |  |
| Dev |  |  |
| Test |  |  |
| Lint |  |  |
| Typecheck |  |  |
| Build |  |  |

## Auto Commands

| Phrase | Workflow |
| --- | --- |
| `prepare repository` | Bootstrap/audit repository and AI-dev files. |
| `start a new feature` | Implement a focused feature with tests and quality gate. |
| `investigate a bug` | Reproduce, find root cause, add regression coverage, fix. |
| `review changes` | Review changed code with findings first. |
| `improve frontend design` | Improve UI/UX with frontend and design quality checks. |
| `update knowledge base` | Save durable project/system knowledge to the knowledge folder. |

## Agent Standards

### Scope Control

- Keep changes scoped to the requested behavior.
- Prefer existing architecture, naming, components, utilities, and test style.
- Do not do unrelated refactors, formatting churn, dependency swaps, or file moves.
- Preserve user changes and never reset unrelated work.
- Do not introduce dependencies unless the benefit is clear and the project pattern supports it.

### Code Style

- Read nearby code before editing.
- Match the repository's formatting, naming, module boundaries, and error-handling style.
- Use existing helpers and abstractions before adding new ones.
- Add an abstraction only when it removes real complexity or matches an established local pattern.
- Do not leave TODO placeholders, dead code, debug output, or partial implementations in final work.

### Testing

- Add or update tests for bug fixes, shared logic, data transformations, and user-visible behavior.
- Prefer focused regression tests for bugs.
- Expand coverage when touching shared contracts, build config, auth, persistence, queues, or user-facing flows.
- Do not weaken or delete tests to make a failure disappear.

### Quality Gate

- Read `.ai-dev/quality-gate.md` before final verification.
- Run the narrowest relevant check first, then broader checks when shared behavior or build config is touched.
- If a check cannot run, report the exact reason.
- Do not mark work complete while relevant checks are failing.

### Frontend Quality Gate

- Verify responsive layout on desktop and mobile when UI changes are visible.
- Check loading, empty, error, hover, focus, and disabled states when touched.
- Ensure text does not overflow buttons, tables, cards, or navigation.
- Reuse the existing design system before adding one-off UI.
- For meaningful visual work, inspect the app in a browser or screenshot and report that verification.

### Security And Secrets

- Do not commit secrets, tokens, API keys, private credentials, or local-only config.
- Treat auth, permissions, payments, user data, migrations, queues, and external side effects as high-risk.
- Do not run scripts that may send real messages, call paid APIs, publish content, or mutate production data without explicit approval.

## Skill Routing

- Repository setup: `repo-onboarding`
- New feature: `feature-builder`
- Bug/failure: `bugfix-investigator`
- Review: `code-reviewer`
- Frontend/UI polish: `frontend-polisher` plus design skills when visual quality matters.
- Knowledge updates: `knowledge-curator`
- Normal repository work: use `membrane_policy: "auto"` or `"exclude"` if app skills are noisy.
- External app integrations: use `membrane_policy: "include"`.

## Final Response

Always report:

- changed files;
- checks run and results;
- skipped checks and reasons;
- remaining risk or follow-up work.
