---
name: backend-api-engineer
description: Use when Codex must design, implement, or change a backend service, API endpoint, worker, queue consumer, bot handler, or server-side business flow while preserving contracts, data integrity, failure behavior, observability, and focused verification.
---

# Backend API Engineer

## Objective

Deliver the smallest complete backend change that follows repository architecture and remains correct under retries, partial failures, concurrency, invalid input, and dependency outages.

## Workflow

1. Read `AGENTS.md`, `.ai-dev/project-map.md`, `.ai-dev/quality-gate.md`, service documentation, schemas, and nearby tests.
2. Trace the request path from transport through validation, authorization, domain logic, persistence, side effects, and response serialization.
3. State the current contract and the requested behavioral change before editing.
4. Identify invariants: ownership, permissions, uniqueness, state transitions, idempotency, transaction boundaries, and ordering.
5. Choose the narrowest module boundary that owns the behavior. Preserve existing framework and repository patterns.
6. Implement validation and domain behavior separately where the codebase already distinguishes them.
7. Define failure behavior for invalid input, missing data, conflicts, dependency timeouts, retries, and partial side effects.
8. Add or update focused tests at the lowest useful layer, then run nearby integration or contract checks.
9. Inspect the final diff for accidental contract, schema, logging, or configuration changes.

## Contract Checks

- Preserve status codes, response shapes, field nullability, pagination, filtering, sorting, and error identifiers unless the task explicitly changes them.
- Treat generated clients, OpenAPI, GraphQL, protobuf, event schemas, and public types as contracts.
- Validate at trust boundaries. Do not rely on frontend validation for backend safety.
- Keep backward compatibility or document the migration and rollout requirement.
- Make retries safe for create, payment, notification, publishing, and webhook flows.

## Data And Concurrency

- Place transaction boundaries around one business invariant, not arbitrary function length.
- Avoid read-then-write races; use database constraints, atomic updates, locks, or compare-and-set where appropriate.
- Keep external network calls outside database transactions unless atomic coordination is intentionally designed.
- Make queue jobs and webhook handlers idempotent and retry-aware.
- Preserve timezone, decimal, encoding, and identifier semantics.

## Operability

- Emit actionable structured logs without secrets, tokens, personal data, or full payload dumps.
- Preserve correlation or request identifiers.
- Distinguish expected domain failures from unexpected operational failures.
- Add metrics or traces only when they match existing observability patterns and materially improve diagnosis.

## Verification

Run repository-defined commands first. Cover the changed behavior with evidence for:

- happy path;
- validation or authorization failure;
- missing/conflicting state;
- retry or duplicate delivery when relevant;
- database rollback or dependency failure when relevant;
- unchanged neighboring contract behavior.

## Output

Report:

- contract and invariant changed;
- implementation summary;
- tests and commands run;
- migration, rollout, or compatibility notes;
- remaining operational risk.

## Guardrails

- Do not invent a new service layer, repository abstraction, or response envelope without evidence from the codebase.
- Do not weaken authorization, validation, database constraints, or tests to make a change pass.
- Do not log credentials, secrets, access tokens, raw payment data, or sensitive user payloads.
- Do not run destructive migrations or production mutations without explicit approval, backup, and rollback planning.
- Do not claim integration behavior was verified when dependencies were unavailable.
