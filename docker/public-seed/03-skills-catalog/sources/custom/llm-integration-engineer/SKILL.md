---
name: llm-integration-engineer
description: Use when Codex must build or review an LLM, RAG, embedding, agent, tool-calling, structured-output, moderation, or model-provider integration with measurable quality, bounded cost, privacy controls, fallbacks, and production-safe failure behavior.
---

# LLM Integration Engineer

## Objective

Treat model behavior as a probabilistic dependency with contracts, evaluation data, observability, privacy boundaries, and graceful degradation rather than as a reliable string-returning API.

## Workflow

1. Define the user task, unacceptable outcomes, latency target, cost budget, data policy, and deterministic alternatives.
2. Inspect existing provider abstraction, prompts, schemas, tools, retrieval, caching, retries, and evaluation fixtures.
3. Choose the smallest capable model and make provider/model configuration explicit.
4. Define structured input and output contracts; validate every model response before use.
5. Separate system policy, task context, retrieved data, user input, and tool results.
6. Bound context, output tokens, retries, tool loops, concurrency, and spend.
7. Design timeouts, rate-limit handling, malformed output recovery, fallback, cancellation, and partial failure.
8. Build an evaluation set with normal, edge, adversarial, multilingual, empty, and unavailable-dependency cases.
9. Compare the changed behavior against a baseline and record quality, latency, and cost evidence.

## RAG And Embeddings

- Define chunk ownership, metadata, update policy, deletion behavior, and access control.
- Keep retrieval filters aligned with tenant and document permissions.
- Evaluate retrieval separately from answer generation.
- Preserve source identifiers and expose citations only when they are actually grounded.
- Handle stale, duplicate, conflicting, empty, and low-confidence context.
- Version embedding models and rebuild strategy deliberately.

## Tool And Agent Safety

- Use explicit schemas, allowlists, argument validation, timeouts, and bounded iterations.
- Treat model-produced tool arguments as untrusted input.
- Require approval for destructive, financial, privileged, or externally visible actions.
- Make retries idempotent and prevent duplicate side effects.
- Do not allow retrieved text or tool output to override system policy.

## Privacy And Observability

- Minimize data sent to providers and respect configured retention and regional requirements.
- Redact secrets and sensitive data from prompts, traces, logs, caches, and evaluation artifacts.
- Record provider, model, prompt version, latency, token usage, finish reason, retries, and structured failure category where policy permits.
- Avoid logging full prompts or responses by default.

## Verification

Run deterministic schema tests, mocked provider failures, focused integration tests, and the evaluation set. Report baseline versus candidate quality, latency, token/cost estimate, failure rate, fallback behavior, and cases that still require human review.

## Output

Report model contract, evaluation evidence, safety boundaries, operational controls, cost/latency impact, rollout plan, and remaining uncertainty.

## Guardrails

- Do not use production secrets or sensitive user data in local evaluation fixtures.
- Do not claim model quality from a few hand-picked examples.
- Do not execute model-requested privileged actions without validation and approval.
- Do not hide provider, model, prompt, or embedding changes that affect reproducibility.
- Do not remove deterministic validation because the model usually follows instructions.
