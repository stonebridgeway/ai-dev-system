# Prompt Patterns

## Auto-command prompt

```text
<auto-command phrase>: <task details>
Use ai_dev_system MCP. First call match_auto_command, then read_auto_command, then recommend_skills. Follow the matched runbook, project AGENTS.md, project-map, and quality-gate.
```

Recommended phrases:

- `подготовь проект`
- `подготовь репозиторий`
- `начни новую фичу`
- `найди баг`
- `сделай ревью`
- `улучши frontend/design`
- `обнови базу знаний`

## Good task prompt

```text
Implement X in this repository.
Use existing patterns.
Update tests if behavior changes.
Run relevant checks and summarize changed files.
```

## Good bug prompt

```text
Investigate this bug: ...
Find root cause before editing.
Add a regression test if possible.
Run relevant checks.
```

## Good review prompt

```text
Review this PR/diff.
Find bugs, regressions, missing tests, security risks.
Findings first with file and line references.
```
