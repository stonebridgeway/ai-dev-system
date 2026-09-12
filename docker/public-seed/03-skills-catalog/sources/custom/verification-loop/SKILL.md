---
name: verification-loop
description: Use when a change is believed to be finished and before verify_task or complete_task, to prove it with a fixed loop of build, types, lint, tests with coverage, change hygiene, and a diff review, and to report the result in a standard verification report.
---

# Verification Loop

Six phases with a stop rule each. Run the narrowest phase that can prove the change first, then widen. A generated report, a dry run, or stale evidence is never proof.

## Workflow

1. Build: run the project's build command from `.ai-dev/quality-gate.md`. If it fails, stop and fix before anything else.
2. Types: run the type checker (`tsc --noEmit`, `mypy`, `pyright`, `go vet`, `cargo check`). Report every error; fix the ones in touched code before continuing.
3. Lint: run the linter. Fix the code, never weaken the configuration (`verify_change_hygiene` warns when a linter config changed alongside code).
4. Tests with coverage: run the test suite for the touched packages, then the broader suite when shared code changed. Target 80% of changed code; new behavior needs a new test.
5. Change hygiene: call `verify_change_hygiene` (or rely on `verify_task`, which runs it). Every finding comes back as `{ rule, severity, file, line, message, excerpt }`. A `block` finding (secret, `.only`, conflict marker, debugger) must be fixed before continuing; `warn` findings must be fixed or justified in the checkpoint note, quoted as `rule` at `file:line`.
6. Diff review: read `git diff --stat` and the full diff of every changed file. Look for unintended changes, missing error handling, missing edge cases, leftover debug output, and files that should not be committed.
7. Bind the evidence: call `verify_task` after the final edit so the checks are recorded against the current Git state; re-run it after any later change.

## Output

```
VERIFICATION REPORT
Build:     PASS|FAIL
Types:     PASS|FAIL (N errors)
Lint:      PASS|FAIL (N warnings)
Tests:     PASS|FAIL (X/Y passed, Z% coverage of changed code)
Hygiene:   PASS|WARN|BLOCK (N findings)
Diff:      N files changed, reviewed
Overall:   READY|NOT READY
Issues to fix: ...
```

Include the `verify_task` verification id and the skipped checks with their reasons.

## Guardrails

- Do not claim a phase passed without running it in this session on the current code.
- Do not skip, delete, or weaken tests to make the loop green; fix the implementation unless the test itself is wrong.
- Do not use `--no-verify`, `dry_run`, or a previous run as evidence.
- Never paste secrets or credentials into the report.

## Verification

The loop is complete when `verify_task` returns `passed: true` for the current source-state fingerprint and every acceptance criterion is `met` or explicitly waived with a reason.

Then score the work with the `self-evaluation` skill before `complete_task`: the report itself is linted, and a rationalization no passing check backs is refused.
