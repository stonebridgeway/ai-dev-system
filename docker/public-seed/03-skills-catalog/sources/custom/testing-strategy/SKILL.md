---
name: testing-strategy
description: Use when a change needs a deliberate test level, fixture strategy, flake diagnosis, or coverage target before implementation.
---

# Testing Strategy

## Procedure

1. Map the changed behavior to unit, integration, protocol, browser, or end-to-end evidence.
2. Pick the narrowest test that proves the contract, then add one regression case for the failure mode.
3. Use isolated temporary fixtures for filesystem, process, and network boundaries; do not write to the user's runtime home.
4. Run the focused test first, then the repository quality gate when shared code or configuration changed.
5. If a test is flaky, reproduce it repeatedly, record the environmental dependency, and fix the synchronization or isolation cause.

## Ready when

The test level is justified, the fixture is isolated, the regression case fails before the fix when practical, and the final evidence includes the exact command and result.

## Evidence

Report the test command, pass/fail counts, coverage if relevant, and any intentionally unrun broader checks.

## Tools

Use `begin_task`, `checkpoint_task`, `verify_task`, `run_quality_gate`, and the project's native test command.
