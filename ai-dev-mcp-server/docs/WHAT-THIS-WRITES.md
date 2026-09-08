# What this writes into your repository

Project preparation creates or refreshes a small, inspectable set of files:

- `AGENTS.md` — project-local operating rules.
- `.ai-dev/project-brief.md`, `.ai-dev/project-map.md`, and `.ai-dev/quality-gate.md` — bounded project memory and checks.
- `.ai-dev/context/*.json` — task-specific context packs; review these before implementation.
- `.ai-dev/frontend/*` and `.ai-dev/frontend-qa-report.md` — only when frontend workflows run.
- `.ai-dev/archify/*` — only when a project-scoped diagram artifact is requested.

The system also keeps runtime state, indexes, logs, and receipts under the configured runtime home. Add generated `.ai-dev` artifacts to version control when they are part of the team's workflow; otherwise use a targeted `.gitignore` entry rather than ignoring the whole directory blindly.

No project file should silently change because a read-only tool was called. Write operations are explicit and return the affected path.
