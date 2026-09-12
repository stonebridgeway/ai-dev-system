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
5. `extensions/`: capabilities registered from outside `mcp-stdio.mjs` (see below).
6. `hooks/`: standalone scripts run by the *agent*, not by the server (see below).
7. `09-mcp/search-index`: FTS and BGE-M3 hybrid retrieval.
8. Obsidian: human-readable knowledge, generated project cards, workflows, and reports.
9. `${AI_DEV_HOME}/state` (default `~/.ai-dev/state`): runtime task state and evidence that should not clutter the vault.

Archify is a local, vendored diagram capability. Its nine typed MCP tools and
artifact/evidence contract are documented in [ARCHIFY.md](ARCHIFY.md).

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

### Extensions

`src/mcp-stdio.mjs` is capped by the static quality gate, so a new capability is not written into
it. `src/tool-extensions.mjs` holds a registry of factories; each module under `src/extensions/`
exports one:

```js
createXxxTools(host) -> { definitions, handlers, readOnly }
```

`host` is assembled once by `mcp-stdio.mjs` and carries the shared runtime services an extension is
allowed to touch — `taskStore`, `usageLedger`, `sessionStore`, `instinctStore`, project identity and
project-file helpers, the vault layout (`vaultPaths`) and its readers and writers, the live status
sources (search index, embedding backend, registries), and `callTool` for composing existing tools.
The dependency runs one way: extensions never import `mcp-stdio.mjs`, which would both cycle and
couple pure logic to the vault. Duplicate tool names and definitions without a handler throw at
startup, so a broken extension can never reach a client.

Registered today: `decisions`, `frontend-design`, `frontend-qa`, `hooks`, `hygiene`,
`instincts`, `lifecycle`, `mcp-inventory`, `plans`, `projects`, `pull-requests`, `rules`, `search`, `sessions`,
`skills`, `snapshots`, `system`, `usage`, `worktrees`. Pure logic stays in `core/` (`decision-ledger.mjs`, `agent-hooks.mjs`,
`change-hygiene.mjs`, `instincts.mjs`, `task-plans.mjs`, `pull-request.mjs`,
`pr-template.mjs`, `rules-library.mjs`, `rules-catalog.mjs`, `session-memory.mjs`,
`skill-catalog.mjs`, `skill-cards.mjs`, `skill-registry-docs.mjs`,
`skill-quality-report.mjs`, `skill-recommendation.mjs`, `frontend-product-quality.mjs`,
`reference-factory.mjs`, `reference-factory-artifacts.mjs`, `frontend-qa-report.mjs`,
`search-runtime.mjs`, `search-eval.mjs`, `project-cards.mjs`, `project-markdown.mjs`,
`quality-gate-runner.mjs`, `task-verification.mjs`, `task-completion.mjs`,
`system-health.mjs`, `system-dashboard.mjs`, `text-format.mjs`, `usage-ledger.mjs`,
`task-worktrees.mjs`, `task-snapshots.mjs`, `policy-rules.mjs`, `mcp-inventory.mjs`,
`toml-lite.mjs`); the extension is the MCP surface over it.

`core/` is not only pure logic. A handful of modules there are services: they run processes
or own state, but know nothing about MCP and take everything environment-specific as a
dependency. `process-runner.mjs` and `input-process-runner.mjs` were the first; stage 1.4
added `search-index.mjs` and `embedding-workers.mjs`, and stage 1.5 `project-detection.mjs`.
The rule they follow is that the launcher, the paths and the collaborators arrive as
arguments, so the module is testable against a stub rather than against an installed
toolchain.
`core/completion-claims.mjs` has no extension of its own: the `lifecycle` extension is its only
caller.

The `hooks` extension also owns the rules the installed guard enforces. `core/policy-rules.mjs`
is the writing end of the `rules` block in `.ai-dev/policy.json`: it compiles a pattern the way
`hooks/lib.mjs` compiles it, refuses one that cannot work (a pattern that does not compile, an
event the guard never evaluates, a quantified group holding an unbounded quantifier), refuses a
second rule that fires on the same text, and refuses a new pattern that does not match the
example the caller provides. The example is stored on the rule, so `list_policy_rules` re-runs it
and reports a rule a hand edit silently disarmed. Nothing here imports the hook pack: the hooks
are copied into other repositories and must not depend on server code, so the compile flags and
the match text are mirrored, and tests pin the mirror.

`mcp-inventory` reads the other half of the harness: which MCP servers the repository wires into
its agents. `core/mcp-inventory.mjs` reads `.mcp.json`, both Claude Code settings files,
`.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json` and `.codex/config.toml` — the
last through `core/toml-lite.mjs`, a reader for the TOML subset those files use, because a third
dependency costs more review than the parser does. One entry per server names the files that
declare it, the transport, the environment substitutions and whether they resolve, and Claude
Code's approval state. A credential written out in a config file is a `block` finding, masked out
of the command line the report echoes back.

`snapshots` keeps a turn undoable. `core/task-snapshots.mjs` records the whole working tree of a
task — tracked changes, staged or not, plus the files the agent created — as one commit object
that no branch points at, held by a ref under `refs/ai-dev/snapshots/<task_id>/<n>`, and
`rollback_task` restores those files and removes the ones that appeared since. Nothing is
written to the user's branch, their stash or their index; `.gitignore` decides what is carried,
so dependencies and build output stay out of it. The lifecycle drives it at both ends:
`checkpoint_task` snapshots the turn it records (a repository that cannot be snapshotted leaves
a reason, never an error), and `complete_task` deletes the refs the closed task no longer needs.
A rollback snapshots the state it is about to replace, so it can itself be rolled back.

`pull-requests` is the one extension that reads from every other: `prepare_pull_request`
projects a task record, its verifications, its decisions and its plan onto the repository diff
and writes `.ai-dev/pr/<task_id>.md`. It fills the repository's own pull request template when
there is one (`core/pr-template.mjs` discovers, parses and fills it), and it stops at text —
`git push` and `gh pr create` are returned as commands, never executed, so publishing stays a
human decision. `complete_task` prepares the same file and links it from `next_step`.

`system`, `skills`, `frontend-design`, `frontend-qa`, `search`, `projects` and `lifecycle` are
extractions from `mcp-stdio.mjs` rather than new capabilities; each moved out with its
definitions and each splits the same way, I/O in the extension and judgement in `core/`. Those
six steps took the main module from 10,018 lines to 4,775.

`system` carries `system_health_check`, `rebuild_system_dashboard` and `system_dashboard_status`.
Its checks fetch through `host` and hand the raw status objects to pure evaluators in
`core/system-health.mjs`, which also assembles the dashboard snapshot.

### Skill routing: three conventional slots plus reserved ones

`recommend_skills` answers with at most three conventional skills — one workflow, plus domain and
verification skills — chosen deterministically by `core/skill-router.mjs` from the task text. Those
three are ours: they carry the verification contract the task lifecycle checks against, so nothing
displaces them.

Beside them sit the reserved roles (`RESERVED_ROUTING_ROLES`), which do not consume the three:

- `capability` — an add-on tool such as Archify, matched by a routing rule. It is not an
  alternative to a workflow skill, so it does not compete for a slot.
- `specialist` — at most one imported skill (`external/*`, `design/*`), picked by
  `pickTaskSpecialist` in `core/skill-recommendation.mjs`. It earns the slot the way its author
  intended: by its `use_when` answering the task's situation. The 101 skills imported from ECC
  could otherwise never appear at all, because our own three always fill the conventional slots
  (docs/ecc-upgrades/DEBTS.md, Д-1).

The specialist is matched through `core/task-vocabulary.mjs`, which translates the concepts a
Russian task names into the English terms an imported catalogue is written in — "настроить
разработку через тесты" and `tdd-workflow`'s "test-driven development" share no substring, so a
plain text score was always zero. The table names concepts, never skills, so an import benefits
from it without an entry being added. Three rules keep the offer honest: the situation text has to
match (a name the task happens to contain is not enough), an import that shadows one of our names
is never offered, and a skill that declares an ecosystem loses points when neither the task nor
the project mentions it — and is refused outright when the project has a stack and this is not it.

### Imported skills: what limits foreign text, and what does not

Imported skills carry `trust: known-upstream` and `instruction_policy: data-until-review`. Both
are **metadata, not a mechanism**: nothing in this server reads `instruction_policy` before doing
or refusing anything, and changing it to `trusted` would change no behaviour. They are an
inventory — they say the catalogue contains text nobody here has read — and a decision built on
them is a decision built on a label (docs/ecc-upgrades/DEBTS.md, Д-7).

What actually keeps a hundred imported texts out of an agent's context is the shape of the
context pack:

- `compileContextPack` (`core/context-compiler.mjs`) renders three things per routed skill —
  name, source, and the reason it was routed. A skill's body is never inlined, whatever its
  trust level.
- The pack object carries the skill's `path`, so the agent can open it. That is the intended
  boundary: an imported skill is a reading suggestion, and reading it is a deliberate act.
- An import that shadows one of our skill names is never routed at all, and a routed imported
  specialist gets its own slot beside the routed core rather than displacing part of it.
- Quality scoring (`skillQualityRankAdjustment`) moves an imported skill's rank, not its
  trustworthiness: `maturity: draft` and `quality_status: fail` push it down the list.

So the protection is that foreign text does not arrive on its own, not a promise that it is
harmless.

`skills` carries `rebuild_index`, `validate_skill_library` and `recommend_skills` — the generated
skill catalog end to end. The extension reads the vault, the skill sources and the embedding
backend; the renders and verdicts are `core/skill-cards.mjs` (cards),
`core/skill-registry-docs.mjs` (registry files and their Markdown),
`core/skill-quality-report.mjs` (the validation report and its dashboard) and
`core/skill-recommendation.mjs` (task intent, filtering and ranking), over the shared vocabulary in
`core/skill-catalog.mjs`. Two things stayed behind deliberately: the skill collectors and the
taxonomy/card writers, because `import_skill_repo`, `rebuild_skill_taxonomy` and `sync_skill_cards`
share them, and `projectRecommendationContext`, which is project-card I/O. Both reach the extension
through `host`. The traffic runs the other way too — `import_skill_repo` and the overlay tools call
`rebuild_index`, and `begin_task` calls `recommend_skills` — and both go through
`extensions.handlers`, so the tool stays the single implementation.

`frontend-design` and `frontend-qa` are one capability cut in two, because the Frontend Product
Quality surface is larger than one 800-line module. `frontend-design` carries the inputs a product
is built from: the Reference Factory (`plan_frontend_references` mints a manifest of image jobs,
`register_frontend_references` accepts the generated PNGs only against per-artifact inspection
evidence) and `generate_ui_ux_design_system`. `frontend-qa` carries the evidence that the built
thing works: `run_frontend_qa` drives the browser runner, `run_visual_reference_qa` is the strict
form of it behind the implementation gate, and `record_visual_review` records an independent
reviewer's verdict and hashes every artifact as it is reviewed.

What did not move is the frontend product state itself. `readFrontendProductState`,
`frontendProductDocumentHashes`, `frontendReviewArtifactsCurrent` and the reference validators stay
in `mcp-stdio.mjs` and reach the extensions through `host`, because `compile_project_context`,
`verify_task`, `frontend_product_gate` and the rest of the product state machine read them too.
`verify_task` calls `run_frontend_qa` back through `extensions.handlers`, so the tool stays the
single implementation of a browser run.

Their pure halves are `core/reference-factory-artifacts.mjs` (where a manifest's files live, what a
registry entry looks like, PNG structure, and whether an artifact is one a reviewer could have
inspected) and `core/frontend-qa-report.mjs` (the runner's stdin contract, the Markdown report, the
artifact list a review has to cover, and the strict verdict). `core/frontend-product-quality.mjs`
and `core/reference-factory.mjs` already held the state machine and the manifest logic and were not
touched: both are pinned in the static gate's `MODULE_LINE_EXCEPTIONS` and may only shrink.

`search` is the MCP surface over three layers. `core/search-index.mjs` owns the sqlite index:
when to rebuild it (writers call `markDirty`, the next query rebuilds once, concurrent queries
share that rebuild), what to ask the Python helper, and what to do with the answer — the dense
query vector is embedded in-process and handed over as a file, results are reranked against the
golden cases, and deterministic intent routing can place a routed workflow skill above
everything the index found. `core/embedding-workers.mjs` owns the BGE-M3 pool: one long-lived
worker per model/device pair, newline-delimited JSON over stdin/stdout, and a one-shot fallback.
`core/search-runtime.mjs` and `core/search-eval.mjs` are pure: the presets an agent actually
names (`code`, `docs`, `skills`, …), weight normalization, the per-result score explanation, and
the golden-case verdicts and ranking metrics.

Both services are created once in `mcp-stdio.mjs` and handed to the host as `search` and
`embeddings`, because they are shared rather than owned by the extension: the system extension's
health checks query them, fourteen writers across the runtime call `markSearchIndexDirty`, and
`prepare_project` rebuilds the index directly. The reverse direction goes through
`extensions.handlers`, as everywhere else.

`projects` carries one tool, `run_quality_gate`: the only place the server executes commands a
project wrote down for itself. Reading the gate file, choosing what to run and judging the run
are pure, in `core/quality-gate-runner.mjs` — a gate file is prose an agent edits, so its
commands are parsed out of bullets and tables rather than configured, and the verdict keeps the
three kinds of nothing-happened apart (`no_commands`, `blocked`, `no_commands_run`). The
extension resolves each command's working directory, runs it under the command policy, and
writes the result back onto the project's registry card. `verify_task` runs the gate as one of
its checks and reaches it through `extensions.handlers`, so the tool stays the single
implementation.

What did not move is `detectProject`, and deliberately: it is a service, not a tool. `begin_task`,
`compile_project_context`, the card writers and the `frontend-qa`, `rules`, `sessions` and
`instincts` extensions all ask it what a repository is, which is eleven callers inside
`mcp-stdio.mjs` and four outside it. It lives in `core/project-detection.mjs` over an injected
filesystem — `pathExists`, the JSON and text readers, `stat`, the path guard and the deep
`analyzeProject` pass all arrive as arguments — and `mcp-stdio.mjs` binds it to the real one and
puts it on the host. The shallow pass
reads the manifests at the root, the deep pass walks the tree, and the deep result wins where they
disagree, because a monorepo's real commands live in its packages.

The project registry card splits the same way. `core/project-cards.mjs` renders it from facts that
arrive already gathered, which is what makes it safe to re-render: the sections an agent owns —
architecture notes, active tasks, risks, improvements, notes, the last gate and QA runs — are
carried over from the card as it stands and generated only when it has none.
`core/project-markdown.mjs` holds what the card shares with `AGENTS.md`, the project map, the
project brief and the gate file: the command and component tables, the documentation and
environment sections, the section readers and the project slug.

`lifecycle` carries the arc every other tool is arranged around: `begin_task` opens a bounded
task against a compiled context pack and at most three routed skills, `checkpoint_task` records
progress against its acceptance criteria, `verify_task` runs the checks that could prove the work,
and `complete_task` closes it and writes down what happened.

It is the extension with the most connections, and all of them run through `host`: the task store
and the skill-outcome store, project identity and detection, project-state capture, the frontend
product state, the Archify receipt store, the project-card writers and the knowledge-note writer.
The four sibling tools it drives — `recommend_skills` for routing, `run_quality_gate` and
`run_frontend_qa` as verification checks, `prepare_pull_request` at completion — arrive the same
way, as host wrappers over `extensions.handlers`. That is deliberate rather than incidental:
reaching them through `callTool` instead would record a second usage-ledger entry for work the
client never asked for, so a composed run would be counted twice.

Its judgements are pure. `core/task-verification.mjs` decides whether a run passed (an empty run
never does, and an unknown check type fails closed) and which acceptance criteria that passing run
is evidence for — criteria are matched on the text `begin_task` wrote, which is why those rules
read like prose. `core/task-completion.mjs` renders the completion note and says what is left to do
with the branch. The refusals stay in the extension because they are about order rather than
judgement: a rationalized report is refused by `core/completion-claims.mjs` before anything is
written, and a completed task is refused re-verification before any runner starts.

### Context extras

`core/context-extras.mjs` lets an optional subsystem contribute a section to the compiled context
pack without the context compiler knowing it exists. A provider takes the same input and returns
`null` or `{ id, title, markdown, items }`:

- `decisions` — recent records from `<projectRoot>/.ai-dev/decisions`.
- `handoff` — the newest substantive session: next step, blockers, and approaches that already
  failed, tagged with their age so a stale handoff is not trusted blindly.
- `instincts` — learned preferences that pass the relevance filter for this project and task.

Providers must be cheap, read-only, and must not throw. A provider that fails is reported as an
`unknown` entry in the pack instead of failing `begin_task`.

### Hooks

`hooks/*.mjs` are not part of the server process. `install_agent_hooks` copies them into
`<project>/.ai-dev/hooks/` and registers them with the agent — `.claude/settings.json` for Claude
Code, `.cursor/hooks.json` for Cursor — merging into whatever is already there and
replacing only previous AI Dev entries. The agent then spawns each script per event, with the event
JSON on stdin.

The Cursor side is a versioned adapter: `CURSOR_HOOKS_CONTRACT` (in `core/agent-hooks.mjs`) pins the
`hooks.json` format version, the event names, the deny-response shape, the date all three were last
checked, and the sources they were checked against; `cursorHooksDocument(profile, { version })`
picks a builder per format version and refuses an unknown one, so a new Cursor format gets its own
builder rather than a rewrite of the current one. What the merge cannot decide comes back as
`warnings` from `install_agent_hooks` — a file that declares another format version, and events
where a foreign hook sits ahead of ours, since Cursor runs the first entry of an event.

| Script | Event | What it does |
| --- | --- | --- |
| `guard.mjs bash` | PreToolUse (Bash) | Blocks git-hook bypasses, destructive and publishing commands, and policy `block` rules. |
| `guard.mjs file` | PreToolUse (Write/Edit) | Blocks secret-bearing paths, secrets in new content, and weakened linter or protected configuration. |
| `fact-force.mjs` | PreToolUse, via `guard.mjs` | Under `fact_force`, refuses the first edit of a file in a session until a `FACTS <path>` block names its importers, the API it changes, the data it touches and the instruction it serves, and the first destructive command until a `ROLLBACK:` line says how to get back. Reads the transcript for both. |
| `compact-advisor.mjs` | PreToolUse (Edit/Write) | Suggests `/compact` from real context size — the `usage` of the newest assistant message in the transcript — plus a per-session tool-call count. Never blocks. |
| `post-edit.mjs` | PostToolUse | Formats the edited file with the project's own formatter when one is installed locally — never installs anything, never uses `npx`. |
| `session-start.mjs` | SessionStart | Injects the last handoff, open tasks, high-confidence instincts, and the installed rules index into the first turn. |
| `session-end.mjs` | Stop, PreCompact | Distils the transcript into an unconfirmed draft record (`confirmed: false`) for `resume_session`, and writes the observation log beside it (`observe-<session>.json`: what the user said, what tools ran with what, which calls failed) that `propose_instincts` reads. |
| `cost-capture.mjs` | Stop | Sums the `usage` of the assistant messages the transcript gained since the last run and appends them to the usage ledger, per model. Tokens only — the report prices them. |
| `git-hooks.mjs` | git `pre-commit`, `pre-push` | Installed through `core.hooksPath` by `targets: ["git"]`, so they run for every client and for a human at a terminal. `pre-commit` refuses a staged secret, conflict marker, focused test or left-behind debugger; `pre-push` reports an active task with no verification or a failed one. |
| `stop-check.mjs` | Stop | Cheap checks on git-modified files: leftover `console.log`/`debugger`, secrets, and a `verify_task` reminder while a task is active with uncommitted changes. |

`.ai-dev/policy.json` is the knob: a `profile` (`minimal` — guard and session capture only,
`standard`, `strict`), `allow_config_edits`, `format_on_edit`, the compaction thresholds
(`compact_tool_threshold`, `compact_tool_interval`, `compact_context_threshold` — absolute, `0`
derives it from the window — `compact_context_thresholds.standard` / `.large`,
`compact_context_window`, `compact_context_interval`), `model_rates` (per-model price overrides
for the usage report, in USD per million tokens), `completion_claims` (the completion-statement
linter: `enabled`, and `waivers` of `{ rule, reason, expires? }` where the reason is real),
`fact_force` (the grounding gate: `enabled` — on by default under `strict` — `files`, `bash`,
`expiry_minutes`, `max_denials`, `max_entries`, `exempt_globs`), `git_hooks` (`pre_commit` and
`pre_push`, each `block`, `warn` or `off`), and a list
of hookify-style `rules` (`{ id, event, pattern, action, message }`) that add project-specific
`block` or `warn` patterns without touching the scripts. Hooks fail open: any error exits 0 so a
broken hook never wedges the agent.

What `session-end` writes is a draft, not a handoff: the fields come from heuristics over the
transcript, so the record carries `confirmed: false` and every reader shows it with that caveat —
`resume_session` (`unconfirmed: true`, plus the drafts still pending) and the `session-start`
context injection. `save_session` with `confirm_hook_draft: true` promotes one: the agent's own
fields win, the draft fills the rest, the saved record is marked `confirmed` with `confirmed_from`,
and the draft file is removed.

What `cost-capture` writes is tokens, not money. A Claude Code transcript is append-only JSONL, so
the hook keeps a byte cursor per session (`state/usage/sessions/<session>.json`), reads only what
arrived since the last Stop, sums `usage` per model over the assistant messages in it — subagent
turns included, since they are billed the same — and appends one `kind: "usage"` event per model to
`state/usage/events.jsonl`. It writes the file directly rather than calling `record_usage`, because
the server may be in Docker while the hook runs on the developer's machine. Prices live in
`core/usage-ledger.mjs` (`RATE_TABLE`, read from Anthropic's pricing page on the date in
`RATE_TABLE_SOURCE`, with the cache multipliers — write 1.25x, read 0.1x — filling the rows that do
not state them) and are applied by `usage_report` at read time, so a price change re-prices history
instead of freezing a stale number into the ledger. A model the table does not know is reported
under `rates.unpriced_models` rather than counted as free.

### State roots

`${AI_DEV_HOME}/state` (`AI_DEV_STATE_ROOT`, default `~/.ai-dev/state`) holds everything that is
runtime state rather than knowledge:

```text
${AI_DEV_HOME}/state/
  tasks/<task-id>.json      task records (authoritative lifecycle state)
  sessions/<repository-id>/ session handoffs, one file per save; hook-<id>.json is an unconfirmed
                            hook capture until save_session(confirm_hook_draft) promotes it
  instincts.json            learned preferences with confidence and decay
  usage/events.jsonl        tool-call and token/cost ledger, pruned by size
  usage/sessions/<id>.json  how far cost-capture has read each session's transcript
  skill-outcomes.json       verification-bound routing outcomes
  pilots.json               pilot reviews
  archify-receipts/         server-owned receipts keyed by artifact SHA-256
```

Three levels, deliberately kept apart: the vault is shared knowledge, this tree is per-user runtime
state, and `<project>/.ai-dev/` (decisions, plans, context packs, rules, hooks, policy) is per-repository
and belongs in the repository's own history.

Memory inside that tree is keyed by `repository_id` — a hash of `git rev-parse --git-common-dir` plus the
project's path inside its worktree — which is the same string in the main checkout and in every linked
worktree of one clone. A handoff saved while working in a `begin_task_in_worktree` worktree therefore
resumes from the main checkout, and an instinct recorded in either is visible in both. Tasks keep their
own `project_id` (a hash of the canonical working-tree path), so a task stays bound to the tree it was
started in. Records written before repository ids existed are still read under their `project_id` and
move to the repository key on the first write. Outside Git (no common dir) `repository_id` is `null` and
`project_id` remains the only key.

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

A task record (`${AI_DEV_HOME}/state/tasks/<task-id>.json`) is the authoritative lifecycle state:

```jsonc
{
  "schema_version": 1,
  "id": "task-<timestamp>-<hash>",
  "status": "active | complete",   // "complete" only through complete_task
  "task": "...",
  "project": { "id", "repository_id", "name", "path", "aliases", "types", "stack", "components" },
  "risk": "low | medium | high",
  "plan_policy": {
    "complexity": "small | medium | large",
    "score": 0,
    "plan_required": false,
    "reasons": ["..."],
    "suggested_effort": "low | medium | high",
    "suggested_model_tier": "fast | balanced | deep"
  },
  "plan": null,
  "acceptance_criteria": [{ "id": "AC-1", "text": "...", "status": "pending", "evidence": [], "note": "" }],
  "skills": ["..."],
  "parent_id": "",                 // set on a child of an epic
  "depends_on": [],                // sibling task ids this child waits for
  "epic": null,                    // { "children": ["task-..."] } on the parent
  "context": {
    "worktree": { "path", "branch", "base_ref", "main_root", "created", "removed_at?" }
  },
  "baseline": { /* project fingerprint at begin_task */ },
  "checkpoints": [],
  "verifications": [],
  "completion": null
}
```

- `plan_policy` is computed at `begin_task` from complexity signals and risk. When it says
  `plan_required`, the task gets an extra acceptance criterion that only `plan_task` can meet, so
  the plan gate is enforced through the normal completion rules rather than a special case.
- `parent_id`, `depends_on` and `epic` are the epic links (`core/task-epics.mjs`). A task is a
  child when `parent_id` names one, a parent when `epic.children` lists any, and most tasks are
  neither. `decompose_task` opens each child through `begin_task` — so a child is a task in every
  other respect — and writes the links afterwards, because a dependency is an id and the ids only
  exist once the children do. A reference to nothing, a child waiting for itself and a cycle are
  refused before any child is created. `complete_task` on a parent is refused while a child is
  open or a child record is missing; `epic_status` reports what is ready, what is blocked by what,
  and an epic where every open child waits for another open one.
- `context.worktree` is present only for a task opened with `begin_task_in_worktree`. It records
  where the isolated checkout lives and which branch it is on; `complete_task` uses it to point at
  the merge or PR, and `remove_task_worktree` stamps `removed_at` instead of deleting the field.
- Task records contain acceptance criteria, checkpoints, verification evidence, and source-state fingerprints.
- Completion rejects stale evidence and unresolved criteria.
- The report is held to the same standard as the code. `core/completion-claims.mjs` lints the
  `summary` and `notes` of `checkpoint_task` and `complete_task` against the gate signals of the
  latest verification: a rationalization (`pre-existing issue`, `skipping tests for now`, `should
  work`, `works on my machine`, `flaky`) whose gate did not pass — or never ran — is refused with
  the rule, the gate and the way out; over a passing gate the same wording is only a `warn` in the
  response's `completion_claims`. The rule table is data, and `.ai-dev/policy.json` turns it off
  (`completion_claims.enabled: false`) or waives one rule where the reason is real, which also
  requires the report to state that reason.
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

## Line Budgets

`scripts/static-quality.mjs` enforces two ceilings:

- `src/mcp-stdio.mjs` may not exceed `SYSTEM_LINE_CEILING` (5,076 today), which lives in
  `core/system-health.mjs` so the System Dashboard reports the ceiling the gate enforces. The file
  shrank one extraction at a time (docs/ecc-upgrades/PLAN.md, stage 1: 10,018 lines to 4,776 across
  six steps) and the ceiling was re-pinned to its actual size plus roughly 300 lines of working room
  after each step, so it can be edited but not re-grown. New capabilities go into `src/extensions/`,
  so the budget only has to cover editing what is left.
- Every module under `src/core/` and `src/extensions/` stays within `MODULE_LINE_CEILING` (800) —
  the same soft ceiling `COMMON_RULES` puts on user projects.

`MODULE_LINE_EXCEPTIONS` carries the modules that were already over the ceiling when the rule
landed — `core/frontend-product-quality.mjs` at 1,222 lines and `core/reference-factory.mjs` at 812.
An entry pins a module at its current size: it may shrink, never grow, and the gate demands the
entry be dropped once the module is back under the ceiling or gone. All four of those conditions
reject, each verified by breaking it deliberately against a throwaway module and reverting.

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
