---
name: database-migration-guardian
description: Use when Codex must design, implement, review, or troubleshoot a database schema or data migration while protecting existing data, compatibility, lock duration, rollback, deploy ordering, replication, and production operability.
---

# Database Migration Guardian

## Objective

Make schema and data evolution explicit, reversible where practical, compatible with rolling deploys, and supported by evidence instead of optimistic assumptions.

## Workflow

1. Read models, current schema, migration history, constraints, indexes, deployment process, and database-specific guidance.
2. Describe the before state, target state, data volume, write patterns, and application versions that may run concurrently.
3. Classify operations by risk: metadata-only, table rewrite, lock-heavy, backfill, destructive, or irreversible.
4. Prefer expand-and-contract for compatibility-sensitive changes.
5. Separate schema expansion, application rollout, data backfill, constraint enforcement, and cleanup when one transaction would be unsafe.
6. Design idempotent, resumable backfills with bounded batches and observable progress.
7. Define rollback or forward-fix behavior before applying the migration.
8. Test upgrade from a realistic prior schema and verify the resulting constraints and data.
9. Inspect generated SQL when the migration framework can hide expensive operations.

## Safety Review

- Check table locks, rewrite behavior, index build strategy, transaction duration, and replication lag.
- Preserve reads and writes across mixed application versions during rolling deployment.
- Add nullable columns or compatible defaults before enforcing strict constraints when needed.
- Backfill before setting `NOT NULL` or adding validation-sensitive constraints.
- Protect uniqueness with database constraints, then handle resulting application conflicts.
- Treat type changes, column drops, table renames, enum changes, and large default values as high-risk.

## Data Migration Checks

- Define deterministic selection and ordering.
- Make retries safe and record progress.
- Bound memory, transaction size, and write pressure.
- Count source, transformed, skipped, failed, and destination records.
- Preserve timezone, encoding, decimals, identifiers, and referential integrity.
- Keep sensitive values out of logs and reports.

## Verification

Use an isolated database or repository-provided integration environment. Verify:

- clean upgrade from the previous schema;
- application behavior before and after rollout boundaries;
- constraints and indexes exist as intended;
- representative data survives unchanged;
- backfill restart and duplicate execution are safe;
- downgrade or forward-fix procedure is honest and tested where supported.

## Output

Report migration phases, operational risk, lock/rewrite expectations, deploy order, verification commands, rollback or forward-fix plan, and remaining uncertainty.

## Guardrails

- Never run destructive or production migrations without explicit approval, backup confirmation, and a rollback or recovery plan.
- Do not edit migration history already applied to shared environments unless the project explicitly requires repair.
- Do not assume a migration is safe because it succeeds on an empty database.
- Avoid long network calls, unbounded loops, or full-table application loads inside migration transactions.
