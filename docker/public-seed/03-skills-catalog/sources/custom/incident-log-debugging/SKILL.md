---
name: incident-log-debugging
description: Use when diagnosing a production or CI incident from logs, traces, metrics, timelines, and failure evidence.
---

# Incident and Log Debugging

## Procedure

1. Establish the incident window, impact, affected component, and last known good state.
2. Build a timestamped timeline from logs, traces, metrics, deploys, and configuration changes.
3. Separate symptoms from causal hypotheses; test the highest-impact hypothesis with safe read-only checks.
4. Apply a reversible mitigation, verify recovery, and preserve the evidence.
5. Write a follow-up with root cause, contributing factors, detection gap, and prevention owner.

## Ready when

Impact and recovery are evidenced, the root cause is distinguished from correlation, and follow-up actions have owners and acceptance criteria.

## Evidence

Include a redacted timeline, exact commands/queries, relevant error signatures, mitigation result, and residual uncertainty.

## Tools

Use `begin_task`, `read_knowledge`, `search_knowledge`, `checkpoint_task`, and `verify_task`. Never paste secrets into evidence.
