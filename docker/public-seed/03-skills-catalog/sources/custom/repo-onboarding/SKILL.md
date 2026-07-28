---
name: repo-onboarding
description: Use when Codex needs to understand a new or unfamiliar repository before making changes, including discovering architecture, commands, tests, entrypoints, dependencies, project rules, and risk areas.
---

# Repo Onboarding

## Workflow

1. Read `AGENTS.md` and nested guidance files if present.
2. Read README, package manifests, config files, CI files, and docs.
3. Identify stack, entrypoints, core modules, test commands, and build commands.
4. Search for existing architecture patterns before proposing changes.
5. Produce a compact project map and list of useful commands.

## Output

- Project purpose.
- Main stack.
- Key folders.
- Local commands.
- Testing and build commands.
- Risks, unknowns, and likely next files to inspect.

## Guardrails

- Do not edit files during onboarding unless the user explicitly asks.
- Do not infer missing commands when manifests provide exact scripts.
- Prefer evidence from files over model memory.

