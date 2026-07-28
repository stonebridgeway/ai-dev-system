# AGENTS.md

Use this template for repositories that are not yet bootstrapped by `bootstrap_project`.

## Project

- Name:
- Root:
- Project map: `.ai-dev/project-map.md`
- Quality gate: `.ai-dev/quality-gate.md`

## Agent Startup

1. Read this file before changing code.
2. Read `.ai-dev/project-map.md` for architecture and commands.
3. Read `.ai-dev/quality-gate.md` before final verification.
4. Inspect nearby code and existing patterns before editing.
5. Use the AI Dev System MCP tools for knowledge, skills, and auto-command routing:
   - `match_auto_command`
   - `read_auto_command`
   - `recommend_skills`
   - `search_knowledge`
   - `read_skill`
6. Call `recommend_skills` with this repository as `project_path` when no registered project card exists.

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
| `подготовь репозиторий` | Bootstrap/audit repository and AI-dev files. |
| `начни новую фичу` | Implement a focused feature with tests and quality gate. |
| `найди баг` | Reproduce, find root cause, add regression coverage, fix. |
| `сделай ревью` | Review changed code with findings first. |
| `улучши frontend/design` | Improve UI/UX with frontend and design quality checks. |
| `обнови базу знаний` | Save durable project/system knowledge to Obsidian. |

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
