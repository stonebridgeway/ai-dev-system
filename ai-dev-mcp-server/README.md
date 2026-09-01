# AI Dev MCP Server

Local, offline-first MCP server for the Obsidian-based AI Dev System. It gives any MCP-capable
coding agent (Claude Code / Desktop, Cursor, VS Code, Gemini, Codex, …) bounded project context,
deterministic skill routing, controlled repository setup, hybrid search, verification, and
evidence-bound task completion.

## Runtime

- `src/server.mjs`: authoritative stdio runtime built on `@modelcontextprotocol/sdk@1.29.0`.
- `src/mcp-stdio-legacy.mjs`: single source of truth for tool dispatch (`callTool`), the
  `tools` contract list, and the hand-rolled JSON-RPC fallback server (`start:legacy`).
- `src/mcp-stdio.mjs`: thin compatibility shim that re-exports the legacy module for
  `server.mjs`, the scripts, and the tests.
- `src/tool-definitions.mjs`: typed MCP tool contracts, separated from runtime dispatch.
- `src/core/`: path, command, process, project identity, context, task, routing, outcome, dashboard,
  overlay, frontend-quality, and distribution modules.
- Node.js: 24+ on `PATH` (any distribution). No agent-specific runtime is required.
- Regenerable runtime data lives under the **AI Dev home** — `AI_DEV_HOME`, default `~/.ai-dev`:
  - `~/.ai-dev/state` — task lifecycle, skill outcomes, pilots (override: `AI_DEV_STATE_ROOT`)
  - `~/.ai-dev/cache/search-index` — SQLite + dense index (override: `AI_DEV_SEARCH_INDEX_DIR`)
  - `~/.ai-dev/artifacts/frontend-qa` — QA screenshots (override: `AI_DEV_FRONTEND_QA_ARTIFACT_ROOT`)
  - `~/.ai-dev/models/bge-m3` — embedding model (override: `BGE_M3_MODEL_DIR`)
  - A pre-existing `~/.codex/<...>` layout is used automatically if the `~/.ai-dev` path is absent,
    so installs migrated from the Codex-only runtime keep their history.

Start:

```bash
AI_DEV_VAULT_ROOT="/path/to/vault" node src/server.mjs
```

The server negotiates MCP over stdio and exposes structured tool results, Resources, resource
templates, Prompts, progress notifications, and tool annotations. Any stdio MCP client works —
Claude Code / Desktop, Cursor, VS Code, Gemini, Codex. Minimal client entry:

```jsonc
{
  "mcpServers": {
    "ai-dev-system": {
      "command": "node",
      "args": ["/path/to/vault/09-mcp/ai-dev-mcp-server/src/server.mjs"],
      "env": { "AI_DEV_VAULT_ROOT": "/path/to/vault" }
    }
  }
}
```

## Main Workflow

For substantive repository work:

1. `prepare_project` once if agent files are missing.
2. `begin_task` with the real repo root and concrete request. It resolves canonical project identity
   and compiles a bounded task-specific context pack.
3. Read the compiled pack and no more than three routed skills.
4. Implement a scoped change and call `checkpoint_task`.
5. For product UI, pass `frontend_product_gate`, run strict visual reference QA, and record independent review.
6. Call `verify_task`; it automatically checks prepared frontend product handoff state.
7. Call `complete_task` only after all criteria are resolved and evidence matches current Git state.

The canonical agent skill is `03-skills-catalog/sources/custom/ai-dev-orchestrator/SKILL.md`.

## Capabilities

Project intelligence:

- `analyze_project`
- `prepare_project`, `bootstrap_project`
- `project_identity`
- `register_project`, `sync_project_card`, `read_project`, `list_projects`
- `refresh_project_map`, `refresh_project_memory`
- recursive monorepo/component, stack, command, entry-point, API, data, CI, and risk detection

Task lifecycle:

- `begin_task`, `get_task`, `list_tasks`
- `checkpoint_task`, `verify_task`, `complete_task`
- `compile_project_context`, `project_context_status`
- `start_project_pilot`, `record_project_pilot_review`, `project_pilot_status`
- `skill_outcome_status`, `rebuild_skill_outcomes`

Skills:

- `recommend_skills` returns one to three deterministic custom skills
- `list_skill_groups`, `browse_skill_group`
- `read_skill_card`, `read_skill`
- `rebuild_index`, `rebuild_skill_taxonomy`, `sync_skill_cards`
- `validate_skill_library`, `run_skill_routing_eval`
- `sync_skill_overlays`, `list_skill_overlays`, `upsert_skill_overlay`

UI/UX design intelligence:

- `generate_ui_ux_design_system`: one product-specific direction with pattern, palette, typography,
  effects, anti-patterns, and optional bounded persistence to
  `.ai-dev/frontend/design-system.md`
- `query_ui_ux_knowledge`: focused local lookup by domain or implementation stack
- curated `ui-ux-pro-max` core pinned to an audited upstream commit; no network or Python packages
- deterministic Russian-to-English query hints for common frontend concepts
- generated recommendations remain drafts; rendered UI and inspected browser evidence are required

Frontend Product Quality v2:

- `frontend_product_builder` selects one orchestrator, one mode specialist, and one quality skill
- `prepare_frontend_product`, `update_frontend_product_brief`, and `record_frontend_directions`
- `plan_frontend_references`, `register_frontend_references`, and `reference_factory_status`
  provide a two-stage Reference Factory when no approved external reference exists
- `record_frontend_concept_jury` requires independent dimension-level comparison before a generated
  direction can be approved
- `approve_frontend_direction` and `approve_frontend_design_system` enforce design-first state
- `frontend_product_gate` blocks stale approved documents and incomplete handoff evidence
- `run_visual_reference_qa` captures desktop/mobile plus named states and compares immutable baselines
- `record_visual_review` binds independent inspection and ten scorecard dimensions to artifact hashes

Reference Factory keeps the tool boundary honest. The MCP server writes a versioned manifest with
surface-specific prompts, dimensions, output paths, and prompt hashes. The client agent must call
ImageGen or Figma, save real PNG files, inspect every artifact, and then register the outputs.
Registration rejects missing or malformed PNGs, unsafe paths, low resolution, duplicate file hashes,
near-duplicate perceptual hashes across directions, stale prompt hashes, and uninspected images.

The first stage generates two or three compact concept sets. After one direction is approved, the
second stage generates complete route, viewport, and state baseline coverage only for that direction.
Design-system approval is blocked while this coverage is missing.

Search:

- `search_all`, `hybrid_search`, `preset_search`, `explain_search`
- `search_projects`, `search_notes`, `search_skills`
- `search_index_status`, `rebuild_search_index`, `run_search_eval`
- SQLite FTS + sparse aliases + local BGE-M3 + deterministic intent candidates
- canonical collapse prevents a skill card and its source from appearing as duplicate results
- Ranking v2 adds intent/scope boosts, source overlays, conflict penalties, hard negatives, mojibake
  repair, and per-result explanations

Verification:

- `run_quality_gate`: allowlisted argv commands, `shell:false`, bounded output and process trees
- `run_frontend_qa`: Playwright desktop/mobile, interaction journeys, console/network checks,
  overflow, axe accessibility, named-state screenshots, anti-slop diagnostics, and visual baselines
- `run_visual_reference_qa`: strict product QA that cannot pass without approved references and later independent review
- `system_health_check`: runtime, indexes, registries, routing benchmark, skills, projects,
  BGE-M3, Frontend QA, and optional smoke/eval checks

Knowledge:

- `search_knowledge`, `read_knowledge`
- `write_knowledge_note`, `append_knowledge_note`
- password notes are intentionally left unchanged and are not published as MCP Resources

Operations:

- `rebuild_system_dashboard`, `system_dashboard_status`
- `prepare_runtime_distribution`, `runtime_distribution_status`
- generated live dashboard, source-specific skill overlays, local CLI, local backup, and guarded
  future-VPS profile

## Resources

Fixed:

- `ai-dev://system/control-center`
- `ai-dev://system/dashboard`
- `ai-dev://system/architecture`
- `ai-dev://projects/index`

Templates:

- `ai-dev://projects/{name}`
- `ai-dev://skills/{name}`
- `ai-dev://tasks/{id}`

Resources are bounded views, not a dump of the vault.

## Prompts

- `format_project_for_ai`
- `start_engineering_task`
- `review_frontend_beta`
- `build_frontend_product`
- `generate_frontend_references`
- `refresh_project_context`

## Skill Quality

Skill Schema v2 separates three claims:

- `structure_status`: deterministic document readiness.
- `validation_status`: `provisional` until real evidence exists.
- `empirical_status`: verification-bound outcomes from actual tasks.

A custom skill is promoted to empirical `pass` only after at least three terminal task outcomes
across two canonical projects, pass rate at least 80%, and at least one human-confirmed review.
Repeated verification attempts for one task do not inflate the sample. `run_skill_routing_eval`
separately validates routing selection; it does not claim implementation success.

## Search Quality

Presets:

- `balanced`, `code`, `docs`, `skills`
- `projects`, `debug`, `frontend`, `quality`

Development presets use deterministic routing candidates before hybrid ranking. BGE-M3 remains
useful for concept/document retrieval, while intent routing prevents broad catalog pages from
displacing the exact workflow skill. Golden cases live in:

- `09-mcp/search-eval/search_eval_cases.json`
- `09-mcp/search-eval/skill_routing_eval_cases.json`

## Semantic search (BGE-M3)

Hybrid search works without a model: SQLite FTS, sparse aliases, and deterministic
intent routing are always on. The optional local `BAAI/bge-m3` reranker improves
concept and document retrieval. The Docker image never bundles the weights
(~2.3 GB); the container mounts a host folder read-only at `/models/bge-m3`.

### From a source checkout

1. Install the Python helper dependencies:

   ```bash
   python3 -m venv 09-mcp/embeddings/.venv
   09-mcp/embeddings/.venv/bin/pip install -r 09-mcp/embeddings/requirements-bge-m3.txt
   ```

2. Download the weights into the model directory the loader expects
   (`$BGE_M3_MODEL_DIR`, else `~/.ai-dev/models/bge-m3`):

   ```bash
   09-mcp/embeddings/.venv/bin/python - <<'PY'
   from pathlib import Path
   from huggingface_hub import snapshot_download
   target = Path.home() / ".ai-dev" / "models" / "bge-m3"
   snapshot_download(
       "BAAI/bge-m3",
       local_dir=target,
       allow_patterns=["*.json", "*.model", "sentencepiece.bpe.model", "pytorch_model.bin"],
   )
   print("downloaded to", target)
   PY
   ```

   The loader checks for `pytorch_model.bin` in that folder and fails clearly if
   it is missing. Set `BGE_M3_DEVICE=cuda` to use a GPU.

3. Point `AI_DEV_PYTHON` at that venv's interpreter (or keep `python3` on `PATH`
   with the packages installed) and run `run_search_eval` / `system_health_check`
   to confirm the dense backend is picked up.

### With the Docker image

```bash
docker build --build-arg INSTALL_BGE_M3=1 --tag ai-dev-system:bge .docker/build-context
```

Download the weights on the host as above, then set `AI_DEV_MODEL_PATH` to that
folder; the launcher mounts it read-only as `/models/bge-m3`.

## Frontend QA Config

Projects may define `.ai-dev/frontend-qa.json`:

```json
{
  "dev_command": "pnpm run dev -- --port 5173",
  "routes": ["/", "/pricing"],
  "viewports": [
    { "name": "desktop", "width": 1440, "height": 900 },
    { "name": "mobile", "width": 390, "height": 844 }
  ],
  "scenarios": [
    {
      "name": "submit form",
      "state": "success",
      "route": "/",
      "actions": [
        { "action": "fill", "selector": "#email", "value": "qa@example.test" },
        { "action": "click", "selector": "button[type=submit]" },
        { "action": "expect_visible", "selector": "[role=status]" }
      ]
    }
  ],
  "required_states": ["success"],
  "check_anti_slop": true,
  "check_accessibility_axe": true,
  "check_visual_regression": true,
  "max_pixel_diff_ratio": 0.01
}
```

Baseline replacement in ordinary diagnostic QA requires explicit `update_visual_baselines:true`.
Strict `run_visual_reference_qa` never updates approved baselines. A screenshot is machine evidence
only after independent inspection is recorded against its current hash.

## Security

- Path checks combine lexical containment and realpath/junction checks.
- File writes use per-file queues and atomic replace/append.
- Shell interpreters, shell operators, inline code, dynamic `npx`, and network commands fail closed.
- Windows npm/pnpm shims resolve to their Node entry point; `cmd.exe` is not used.
- Project tests execute project code. Use a container or disposable VM for untrusted repositories.
- Deploy, publish, migrations, production flows, and account mutations are outside automatic gates.

See `docs/SECURITY.md`.

## Installation

Pinned dependencies:

```bash
npm ci --ignore-scripts --no-audit --no-fund
```

Or restore both MCP and Frontend QA runtimes (`../scripts/restore-runtime.ps1`) — it prefers
`node` / `npm` / `pnpm` on `PATH` and falls back to a bundled Codex runtime only if one is present.

Environment overrides:

```text
AI_DEV_VAULT_ROOT   absolute path to the Obsidian vault (required outside the repo)
AI_DEV_HOME         runtime-data root (default ~/.ai-dev)
AI_DEV_STATE_ROOT   task/outcome/pilot state (default $AI_DEV_HOME/state)
AI_DEV_SEARCH_INDEX_DIR   search index dir (default $AI_DEV_HOME/cache/search-index)
AI_DEV_FRONTEND_QA_ARTIFACT_ROOT   QA artifacts (default $AI_DEV_HOME/artifacts/frontend-qa)
AI_DEV_RUNTIME_CONFIG   path to a runtime profile JSON
AI_DEV_PYTHON       python interpreter (default: python3 on PATH)
BGE_M3_MODEL_DIR    embedding model dir (default $AI_DEV_HOME/models/bge-m3)
BGE_M3_DEVICE       cpu | cuda
```

## Docker

The repository ships a local-only, non-root Docker runtime with Chromium, Python search, a clean
public skill seed, persistent local state, and no network listener. It is built from a generated
allowlist context rather than from the Vault or repository root.

```bash
node scripts/prepare-docker-context.mjs
docker build --tag ai-dev-system:local ../.docker/build-context
node scripts/docker-smoke.mjs --image ai-dev-system:local
```

Passwords, project contexts, task history, indexes, models, caches, logs, backups, `.codex`,
`.ai-dev`, `.obsidian`, and Git history are excluded by policy and audited before every build.
Repositories are visible only when the user explicitly mounts a selected path under `/workspace`.

See [the complete Windows, macOS, Linux, client configuration, Compose, BGE-M3, and GHCR guide](../docker/README.md).

## Acceptance

Fast:

```powershell
..\scripts\run-acceptance.ps1
```

Including the full BGE-M3 golden suite:

```powershell
..\scripts\run-acceptance.ps1 -IncludeDense
```

The suite runs MCP unit tests, real stdio negotiation, lifecycle smoke, real Chromium Frontend QA,
Python search-index tests, coverage thresholds, static modularity checks, and local security checks.

## Local Operations

```bash
./scripts/start-local.ps1   # or: node src/server.mjs
node scripts/ai-dev.mjs doctor
node scripts/ai-dev.mjs dashboard
node scripts/ai-dev.mjs reindex
node scripts/ai-dev.mjs refresh --full
node scripts/ai-dev.mjs distribution
```

Install or refresh the same local stdio server for Cursor, Gemini Code Assist, native VS Code MCP,
and Claude Code. Existing JSON files are merged and backed up before they are changed:

```bash
node scripts/install-local-mcp-clients.mjs           # dry run
node scripts/install-local-mcp-clients.mjs --apply
```

Client configurations point to this repository's `src/server.mjs` (set `AI_DEV_VAULT_ROOT` to
override the vault root) and to `node` / `python3` on `PATH`. Restart or reload each client after
installation. Any model selected inside an MCP-capable client can use the same tools; a raw model
endpoint still needs an MCP-capable host.

The shipped runtime profile is local stdio. A future remote profile is configuration scaffolding,
not an enabled network server: remote mode remains blocked until TLS, authentication, allowlists,
rate limits, and threat review are implemented.

## Backup And Recovery

```powershell
..\scripts\backup-ai-dev-system.ps1 -Label before-upgrade
..\scripts\restore-ai-dev-system.ps1 -Archive <backup.zip> -TargetRoot <empty-folder> -ConfirmRestore
```

Backups contain local vault content, including owner-kept private notes. They remain local and must
not be pushed to a public repository.

See `docs/RECOVERY.md`.
