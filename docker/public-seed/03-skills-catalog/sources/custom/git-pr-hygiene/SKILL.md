---
name: git-pr-hygiene
description: Use when preparing a reviewable branch, commit series, pull request description, changelog entry, or release note.
---

# Git and PR Hygiene

## Procedure

1. Inspect the working tree and identify pre-existing user changes before editing.
2. Keep one behavioral concern per commit; avoid generated churn and unrelated formatting.
3. Use an imperative subject that names the behavior, and include tests plus migration or rollback notes in the body when needed.
4. Write the PR summary around problem, approach, compatibility, risks, and verification.
5. Add a changelog entry for user-visible behavior, compatibility changes, security fixes, or release packaging changes.

## Ready when

The diff is scoped, the commit can be reviewed independently, the PR explains residual risk, and no secrets or local artifacts are included.

## Evidence

Record `git diff --check`, the changed-file list, test commands, and the intended commit/PR boundaries.

## Tools

Use `project_identity`, `begin_task`, `checkpoint_task`, `verify_task`, and `complete_task`.
