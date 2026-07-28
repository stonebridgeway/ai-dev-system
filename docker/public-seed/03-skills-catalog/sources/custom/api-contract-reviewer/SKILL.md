---
name: api-contract-reviewer
description: Use when Codex must review or change REST, GraphQL, RPC, webhook, event, or generated-client contracts for correctness, compatibility, authorization, validation, error semantics, pagination, versioning, and consumer impact.
---

# API Contract Reviewer

## Objective

Treat an API as a consumer-facing contract rather than an implementation detail. Find breaking behavior, ambiguity, and unsafe trust-boundary changes before handoff.

## Workflow

1. Identify every contract surface: route, operation, schema, event, webhook, generated type, documentation, and consumer.
2. Compare current behavior, requested behavior, implementation, tests, and published specification.
3. Classify the change as additive, behavior-changing, deprecating, or breaking.
4. Review authentication, authorization, tenant boundaries, validation, and data exposure.
5. Review request and response shapes, nullability, defaults, enum evolution, identifiers, timestamps, and numeric precision.
6. Review error codes, retry semantics, idempotency, rate limits, pagination, filtering, sorting, and ordering.
7. Trace known consumers and generated clients for compatibility impact.
8. Require contract tests or focused evidence for every changed behavior.

## Compatibility Rules

- Adding an optional response field is usually additive; making a field required is usually breaking.
- Removing, renaming, retyping, or changing nullability of a field is breaking unless the contract is private and all consumers migrate atomically.
- Changing error status, error identifier, pagination cursor, ordering, or default filtering can break consumers without changing the schema.
- New enum values can break exhaustive clients; assess consumer language and generation behavior.
- Webhook and event consumers require versioning, replay safety, stable identifiers, and documented delivery guarantees.
- Deprecation requires a replacement, migration path, observability, and removal criteria.

## Security Checks

- Confirm object-level and action-level authorization, not only authentication.
- Reject mass assignment and over-broad serializers.
- Avoid exposing internal identifiers, stack traces, secrets, or cross-tenant data.
- Validate content type, size, shape, ranges, and untrusted URLs at the boundary.
- Define replay, signature, timestamp, and idempotency behavior for webhooks.

## Verification

Prefer repository-defined contract, integration, schema-generation, and client-generation commands. Verify at least:

- valid request and expected response;
- invalid or missing fields;
- unauthenticated and unauthorized requests;
- not-found and conflict behavior;
- pagination or retry behavior when relevant;
- old consumer behavior for compatibility-sensitive changes.

## Output

Report findings by severity with the affected operation and consumer impact. State compatibility classification, evidence, required migration, and any behavior that could not be verified.

## Guardrails

- Do not call a change backward compatible based only on a schema diff.
- Do not silently broaden permissions or response data.
- Do not invent versioning infrastructure when a smaller compatible change works.
- Do not approve a public contract change without executable evidence or a clearly documented gap.
