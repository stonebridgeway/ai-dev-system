# AI Dev MCP vNext Architecture

## Goals

- Give Codex and Claude compact, current project context instead of dumping the vault.
- Route each task to at most three relevant skills.
- Bind completion claims to acceptance criteria and machine-readable evidence.
- Keep local operation offline-first while using the standard MCP protocol.
- Make every write recoverable and every executable command explicit.

## Runtime Layers

1. `server.mjs`: official MCP SDK transport, protocol capabilities, resources, prompts, and tool registration.
2. `mcp-stdio.mjs`: composed domain-service facade and legacy-compatible rollback handler.
3. `tool-definitions.mjs`: typed MCP contracts separated from dispatch and implementation.
4. `core/`: path policy, atomic storage, command policy, process execution, canonical project
   identity, context compilation, task state, routing, outcome analytics, overlays, dashboard,
   frontend quality, and runtime distribution.
5. `09-mcp/search-index`: FTS and BGE-M3 hybrid retrieval.
6. Obsidian: human-readable knowledge, generated project cards, workflows, and reports.
7. `${AI_DEV_HOME}/state` (default `~/.ai-dev/state`): runtime task state and evidence that should not clutter the vault.

Frontend product projects add a repository-local state machine:

```text
.ai-dev/frontend/product-quality.json
-> approved document hashes and pre-code baseline
-> immutable visual references
-> strict Playwright state evidence
-> independent hash-bound visual review
-> handoff gate
```

`core/frontend-product-quality.mjs` owns the pure routing, policy, document, scorecard, and gate rules. The existing Frontend QA runner owns browser execution and pixel comparison; Frontend Product Quality v2 composes it instead of creating a competing runner.

When approved references do not exist, `core/reference-factory.mjs` adds a bounded two-stage artifact
contract:

```text
concept manifest
-> client ImageGen/Figma execution
-> PNG/path/hash/prompt/inspection validation
-> candidate direction registration
-> independent Concept Jury
-> direction approval
-> coverage manifest for the approved direction only
-> immutable baseline registration
```

The MCP server never claims external image-tool execution. It creates and validates manifests; the
client performs generation and visual inspection.

## Request Path

```text
MCP client
-> official SDK transport
-> typed tool contract
-> domain service
-> path/command policy
-> atomic state or bounded process
-> structured result + evidence
```

Search uses a two-stage path:

```text
task query
-> deterministic bilingual intent router (0-3 custom candidates)
-> SQLite FTS + sparse aliases + BGE-M3
-> intent/scope/source/conflict/hard-negative reranker
-> canonical entity collapse
-> bounded ranked context
```

The router controls workflow selection. Dense similarity remains a retrieval signal and cannot
silently replace the exact task workflow with broad catalog notes. Search explanations expose every
boost and penalty used by Ranking v2.

Substantive repository work compiles context before implementation:

```text
canonical project identity
-> Project Brief / Map / Gate
-> task intent and routed skills
-> relevant source files and bounded excerpts
-> commands, risks, unknowns, freshness fingerprint
-> .ai-dev/context/<task-id>.json + Markdown projection
```

Secret-bearing files and unrelated repository content are excluded. The pack is a cache, not a new
source of truth.

## Task And Quality State

- Task records contain acceptance criteria, checkpoints, verification evidence, and source-state fingerprints.
- Completion rejects stale evidence and unresolved criteria.
- Skill structure scores measure document readiness only.
- Routing benchmarks measure selection behavior only.
- `${AI_DEV_HOME}/state/skill-outcomes.json` records verification-bound task outcomes.
- Empirical skill validation requires three terminal tasks, two canonical projects, at least 80%
  pass rate, and at least one human-confirmed review.
- Pilot reviews measure independent dimension-level product outcomes and revision count without
  replacing task verification.

## Source Of Truth

- Repository code and its `.ai-dev` directory are authoritative for project facts.
- The Obsidian project card is a generated projection plus a preserved manual-notes section.
- Skill `SKILL.md` files are authoritative; cards and graph pages are generated projections.
- SQLite and dense vectors are disposable indexes.
- Task JSON records are authoritative for lifecycle state; Markdown reports are projections.
- Skill overlay JSON is local policy; generated skill cards and dashboard are disposable projections.

## Operations And Distribution

- `System Dashboard.md` is generated from live tool, skill, project, search, outcome, and runtime state.
- `config/runtime.example.json` documents the supported local stdio profile.
- `scripts/ai-dev.mjs` exposes doctor, dashboard, reindex, acceptance, backup, and distribution commands.
- Remote HTTP is intentionally absent. The future VPS profile is rejected until TLS, authentication,
  allowlists, rate limiting, and threat review exist.

## Compatibility

`src/mcp-stdio.mjs` remains runnable as `npm run start:legacy` for rollback. `src/server.mjs` is the
authoritative runtime and has protocol, lifecycle, search, project, Frontend QA, coverage, static
quality, security, and regression acceptance.
