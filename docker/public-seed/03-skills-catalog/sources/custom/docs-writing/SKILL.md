---
name: docs-writing
description: Use when writing or updating README, API reference, troubleshooting, upgrade, runbook, or architecture documentation.
---

# Documentation Writing

## Procedure

1. Identify the reader, task, prerequisites, and one successful outcome.
2. Verify every command, path, option, version, and example against the current code.
3. Put the shortest successful path first; move rationale, edge cases, and reference material after it.
4. Explain generated files, privacy boundaries, failure modes, and rollback when the workflow writes state.
5. Run link, generated-doc, spelling, and relevant command checks.

## Ready when

A new reader can complete the documented task, examples match the implementation, and stale or ambiguous claims are removed.

## Evidence

Record the verification command and the files or generated artifacts checked.

## Tools

Use `read_knowledge`, `search_knowledge`, `run_quality_gate`, and `checkpoint_task`.
