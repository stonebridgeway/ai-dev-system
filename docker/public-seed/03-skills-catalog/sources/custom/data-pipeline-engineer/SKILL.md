---
name: data-pipeline-engineer
description: Use when Codex must design, implement, or repair ETL, ELT, streaming, batch, analytics, ingestion, transformation, or export pipelines with explicit data contracts, lineage, idempotency, quality, observability, and recovery behavior.
---

# Data Pipeline Engineer

## Objective

Build a pipeline whose inputs, outputs, transformations, failure modes, and replay behavior are explicit enough to operate safely after the first successful run.

## Workflow

1. Read source and destination schemas, ownership, schedules, orchestration, storage, retention, privacy, and existing data-quality checks.
2. Define the input contract, output contract, grain, keys, event time, processing time, ordering, and allowed lateness.
3. Trace lineage for every derived field and identify destructive or lossy transformations.
4. Choose batch, micro-batch, or streaming behavior based on latency and correctness requirements.
5. Design idempotency, checkpointing, deduplication, retry, backfill, and replay before implementation.
6. Separate extraction, normalization, validation, transformation, and loading boundaries where failure handling differs.
7. Add data-quality checks and actionable metrics at source, transformation, and destination boundaries.
8. Test with representative, malformed, late, duplicate, empty, and schema-evolution cases.
9. Document recovery and backfill commands without embedding credentials or production-only assumptions.

## Contract And Quality Checks

- Define required, nullable, optional, defaulted, and derived fields.
- Preserve timezone, decimal precision, encoding, identifiers, and partition semantics.
- Validate uniqueness, referential integrity, accepted ranges, freshness, completeness, and volume.
- Decide whether bad records block, quarantine, retry, or continue with an explicit threshold.
- Version schemas and make producer/consumer compatibility visible.
- Avoid silent coercion that converts malformed values into plausible but incorrect data.

## Reliability And Scale

- Bound batch size, memory, concurrency, API rate, transaction size, and checkpoint interval.
- Make repeated execution produce the same result or an explicitly versioned result.
- Separate transient dependency failure from permanent data rejection.
- Support partial restart without duplicating writes or skipping data.
- Track processed, accepted, rejected, retried, late, duplicate, and output counts.
- Reconcile source and destination at a useful business grain.

## Verification

Use repository-defined pipeline tests and isolated data. Verify deterministic transformation, empty input, duplicates, late arrival, schema change, partial failure, restart, backfill, and destination reconciliation where relevant.

## Output

Report contracts, lineage, reliability model, quality rules, commands run, sample counts, recovery procedure, privacy considerations, and remaining uncertainty.

## Guardrails

- Do not run broad production backfills, truncate destinations, or replay external side effects without explicit approval and a dry run.
- Do not include personal data, credentials, or raw sensitive records in logs, fixtures, or reports.
- Do not treat row count equality as proof of semantic correctness.
- Do not add distributed complexity when a smaller deterministic batch flow meets requirements.
