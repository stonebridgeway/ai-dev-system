---
name: bugfix-investigator
description: Use when Codex needs to investigate and fix a bug, failing test, runtime error, CI failure, regression, flaky behavior, or production issue by finding root cause before editing.
---

# Bugfix Investigator

## Workflow

1. Read project guidance, `CONTEXT.md`, and nearby ADRs when present.
2. Capture the exact symptom, expected behavior, environment, and last known good state.
3. Build the narrowest agent-runnable feedback loop that can go red on the reported symptom: a failing test, CLI/HTTP script, browser check, replay, or focused harness.
4. Run the loop, then minimize the reproducer one input, dependency, or step at a time.
5. Rank 3-5 falsifiable hypotheses. For each, state the observation that would confirm or reject it.
6. Test one hypothesis at a time with targeted inspection or uniquely tagged instrumentation. For performance regressions, measure a baseline before changing code.
7. Identify the root cause before writing the fix.
8. Turn the minimized reproducer into a regression test at the public seam when a correct seam exists.
9. Implement the smallest safe fix and re-run both the minimized test and the original scenario.
10. Remove temporary instrumentation and run nearby quality checks.

## Feedback-loop quality

Prefer a loop that is specific, deterministic, fast, and unattended. For flaky failures, raise and pin the reproduction rate instead of accepting an occasional failure. If no red-capable loop can be built, record what was tried and request the missing environment access or a redacted artifact before speculating.

## Output

- Root cause.
- Reproduction command and observed signal.
- Fix summary.
- Regression coverage or the missing seam that prevented it.
- Verification and cleanup evidence.
- Remaining risk.

## Guardrails

- Do not patch symptoms blindly.
- Redact secrets, tokens, authorization headers, and personal data from logs and artifacts.
- Do not delete tests to make failures pass.
- Do not generate a single unfalsifiable theory and treat it as evidence.
- Treat flaky failures as signals until evidence says otherwise.
- Tag temporary diagnostics with a unique marker and prove they were removed before completion.
