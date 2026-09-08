# Prompt Patterns

## Auto-command prompt

```text
<auto-command phrase>: <task details>
Use the ai_dev_system MCP server. Call match_auto_command and read_auto_command when they clarify the workflow, then follow the normal begin_task, checkpoint_task, verify_task, and complete_task lifecycle. Read the project AGENTS.md, project map, and quality gate.
```

Recommended phrases:

- `prepare project`
- `prepare repository`
- `start a new feature`
- `investigate a bug`
- `review changes`
- `improve frontend design`
- `update knowledge base`

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
