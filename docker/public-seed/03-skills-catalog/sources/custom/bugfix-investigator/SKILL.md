---
name: bugfix-investigator
description: Use when Codex needs to investigate and fix a bug, failing test, runtime error, CI failure, regression, flaky behavior, or production issue by finding root cause before editing.
---

# Bugfix Investigator

## Workflow

1. Capture the symptom and expected behavior.
2. Reproduce with the narrowest command or scenario available.
3. Trace the failing path through code, tests, logs, and recent changes.
4. Identify root cause before writing the fix.
5. Implement the smallest safe fix.
6. Add regression coverage if practical.
7. Re-run the failing check and nearby checks.

## Output

- Root cause.
- Fix summary.
- Verification.
- Remaining risk.

## Guardrails

- Do not patch symptoms blindly.
- Do not delete tests to make failures pass.
- Treat flaky failures as signals until evidence says otherwise.

