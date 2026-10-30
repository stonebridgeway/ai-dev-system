# AI Dev MCP Server

Local, offline-first MCP server for the Obsidian-based AI Dev System. It gives any MCP-capable
coding agent (Claude Code / Desktop, Cursor, VS Code, Gemini, Codex, …) bounded project context,
deterministic skill routing, controlled repository setup, hybrid search, verification, and
evidence-bound task completion.

## Runtime

- `src/server.mjs`: authoritative stdio runtime built on `@modelcontextprotocol/sdk@1.30.0`.
- `src/mcp-stdio.mjs`: tool dispatch (`callTool`), the `tools` contract list, and the
  hand-rolled JSON-RPC fallback server (`startLegacyServer`, `npm run start:legacy`);
  `server.mjs`, the scripts and the tests import it.
- `src/tool-definitions.mjs`: typed MCP tool contracts, separated from runtime dispatch.
- `src/extensions/`: tools added as extensions, registered in `src/tool-extensions.mjs`.
- `src/core/`: path, command, process, project identity, context, task, routing, outcome, dashboard,
  overlay, frontend-quality, and distribution modules.
- Node.js: 22.16+ or 24+ on `PATH` (any distribution) — all of search lives in `node:sqlite`,
  which has FTS5 from 22.16; on an older Node, every search tool answers with the version it
  needs. No Python and no agent-specific runtime is required.
- Runtime data lives under the **AI Dev home** — `AI_DEV_HOME`, default `~/.ai-dev`:
  - `~/.ai-dev/state` — task lifecycle, skill outcomes, pilots (override: `AI_DEV_STATE_ROOT`)
  - `~/.ai-dev/config.json` — the settings the desktop app and `settings_set` change; a variable
    set in the environment still wins
  - `~/.ai-dev/vault` — the vault of a package or Windows install, made from the package's seed
    and kept current with it (a clone reads its `docker/public-seed`; override: `AI_DEV_VAULT_ROOT`)
  - `~/.ai-dev/cache/search-index` — SQLite + dense index (override: `AI_DEV_SEARCH_INDEX_DIR`)
  - `~/.ai-dev/artifacts/frontend-qa` — QA screenshots (override: `AI_DEV_FRONTEND_QA_ARTIFACT_ROOT`)
  - `~/.ai-dev/models/bge-m3-onnx` — the ONNX embedding model `--model` installs
    (override: `BGE_M3_ONNX_DIR`)
  - `~/.ai-dev/cache/dense-model` — the record of which model files hashed right, so a
    check does not read 570 MB again
  - `~/.ai-dev/app` — the runtime copies that `npx … setup` and the Windows app make, one folder
    per `<version>-<fingerprint>`, and the Windows install's link to the current one, `app/current`
  - `~/.ai-dev/run` — the daemon's descriptor, lock and usually its socket, a folder of mode 0700
  - `~/.ai-dev/logs` — the daemon's log, `daemon.log`
  - `~/.ai-dev/backups` — the archives `ai-dev backup` writes
  - What the Codex-era runtime kept under `.codex` (`state/ai-dev-system`, its search index,
    artifacts and models) moves into the runtime home once, at the first start, and is recorded in
    `state/runtime-home-migration.json`: from `~/.codex` into `~/.ai-dev`, or, with `AI_DEV_HOME`
    set, from `$AI_DEV_HOME/.codex` — where 2.x read it for that install — into `$AI_DEV_HOME`. A
    place its own variable names is not looked for there, the rest of `.codex` is Codex's own and
    stays, and `.codex` is not read after that.

Start:

```bash
node bin/ai-dev.mjs mcp
```

That is what a client runs: MCP on stdin and stdout, served by the daemon. `AI_DEV_VAULT_ROOT`
names a vault of your own; without it a clone reads its `docker/public-seed` and a package its
`~/.ai-dev/vault`. From a plain clone no vault is needed, and `npm run setup` — or
`npm run clients:install` on its own — writes the entry into Claude Code, Claude Desktop, Cursor,
VS Code, Codex and Gemini for you: the absolute path of the Node that ran it, then
`bin/ai-dev.mjs mcp`, no vault variable, `"type": "stdio"` for VS Code and Claude Code, and
`servers` instead of `mcpServers` for VS Code. `node src/server.mjs`, what 2.x configs run, serves
the same tools in the client's own process.

The server negotiates MCP over stdio and exposes structured tool results, Resources, resource
templates, Prompts, progress notifications, and tool annotations. Any stdio MCP client works —
Claude Code / Desktop, Cursor, VS Code, Gemini, Codex. Minimal client entry:

```jsonc
{
  "mcpServers": {
    "ai-dev": {
      "command": "/absolute/path/to/node",
      "args": ["/path/to/vault/09-mcp/ai-dev-mcp-server/bin/ai-dev.mjs", "mcp"],
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

Every tool, grouped and with its read-only flag and required arguments, is listed in
[`docs/TOOLS.md`](docs/TOOLS.md) — generated from the server's own definitions by
`npm run docs:tools` and checked in CI. The summary below is the map, that file is the index.

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
- curated `ui-ux-pro-max` core pinned to an audited upstream commit; no network and no Python
  packages, but both tools above run the dataset's own Python script — the only tools that need
  Python 3 (`AI_DEV_PYTHON`); without it they say so and `doctor` marks `ui_ux_knowledge` skipped
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
- `learn_from_task`
- `refresh_project_context`
- `build_architecture_diagram`

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
intent routing are always on. The optional local BGE-M3 model improves concept and
document retrieval. The Docker image never bundles the weights: they go into the
data volume once, or a host folder holding `bge-m3-onnx/` is mounted read-only at
`/models`, and the image reads `/models/bge-m3-onnx` first when it holds anything,
else the volume's ([With the Docker image](#with-the-docker-image)).

### From a source checkout

```bash
npm run setup -- --model
```

That downloads the pinned ONNX export `Xenova/bge-m3` — five files, int8, each
checked against the sha256 in `models/bge-m3.manifest.json` — into
`~/.ai-dev/models/bge-m3-onnx` (`$BGE_M3_ONNX_DIR` overrides it), and then embeds
the documents already in the search index, Membrane connectors left out. The model
runs in Node through `onnxruntime-node`: no Python packages, no torch. Both halves
show progress and stop cleanly on Ctrl-C: the download keeps its `.part` and the
next run continues from that byte, the embedding stores every 64 documents and the
next run starts where it stopped. Adding notes later leaves them without a vector
until the next `npm run setup -- --model`, which embeds only what changed.
`npm run dense:doctor` walks the model check stage by stage and names the one that
stopped.

### The model command

```bash
npm run model -- status            # installed, missing, stopped partway, where it downloads from
npm run model -- install           # download (resumable), then embed the documents
npm run model -- import <path>     # copy from a folder or a .zip made on another machine, then embed
npm run model -- verify            # hash every file against the manifest
npm run model -- remove            # delete the model's files and nothing else
```

`--dir <path>` works on another folder, `--mirror <url>` uses a Hugging Face mirror
for one run, `--no-index` skips the embedding, `--json` prints the result. Sources
are `AI_DEV_MODEL_MIRROR`, then `HF_ENDPOINT`, then huggingface.co, a failing one
handing its partial file to the next; `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`
are honoured without `NODE_USE_ENV_PROXY`. `AI_DEV_OFFLINE=1` forbids downloads,
leaving `import`. Exit codes: 0 done, 1 failed, 2 a usage mistake, 130 stopped with
Ctrl-C.

`AI_DEV_MODEL_MANIFEST` names another manifest pinned the same way — the tests point
it at a five-kilobyte stand-in for BGE-M3 (`src/core/synthetic-model.mjs`) and run
import, embedding and hybrid search through the real server with it.

An Intel Mac has no onnxruntime-node 1.30 build, so the model cannot run there:
`dense:doctor` and the health check say so, `setup -- --model` refuses before
downloading, and keyword and sparse search work as everywhere else.

### Coming from the Python backend

2.x could embed with a Python virtualenv and torch (`--dense-python`,
`AI_DEV_DENSE_BACKEND=python`). 3.0 removed that backend. `npm run setup -- --model`
moves an install over: it installs the ONNX model and embeds the documents again —
vectors made by the Python backend belong to another model, are never compared
with ONNX questions, and are replaced by this run. `--dense-python` still works as a
name for `--model`; the old variables are no longer read, and the health check names
any that are still set. See
[INSTALL](../docs/INSTALL.md#coming-from-the-python-backend).

### With the Docker image

The default image already carries the ONNX runtime. Put the weights into the data
volume once, with the network that one run needs; every session after it keeps
`--network none`:

```bash
docker run --rm -it --network bridge --mount type=volume,source=ai-dev-system-data,target=/data \
  ghcr.io/stonebridgeway/ai-dev-system:latest ai-dev model install
```

Or mount a host folder that holds `bge-m3-onnx/` — `~/.ai-dev/models`, where
`npm run model -- install` puts it — read-only at `/models`:
`ai-dev clients install --docker --model=<folder>`, `bootstrap.sh --model-path <folder>`
or `bootstrap.ps1 -ModelPath <folder>` writes the mount into the entries. The image
reads `/models/bge-m3-onnx` first when it holds anything, else the volume's model.
`AI_DEV_MODEL_PATH` is read by the 2.x launchers, kept until 4.0, and by bootstrap
as the default of its model path; a 3.0 entry does not read it.

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

Pinned dependencies, then the first run:

```bash
npm ci
npm run setup
```

`npm run setup` builds what a clone does not ship — the skill registry and its
quality report, the SQLite search index and the skill-routing benchmark — and
ends with the health check, so what is still missing is on the screen. It
reaches the network only when asked: `--frontend-qa` installs the Frontend QA
runner's lockfile with the pnpm it pins and then Playwright's Chromium, and
passes only when that browser launches; `--model` (2.x's `--dense`) downloads the pinned ONNX
export of BGE-M3 (no Python packages) and embeds the index with it. Everything it
builds is idempotent, and anything that has gone out of date since is rebuilt
rather than skipped.

After restoring a backup into a clone, `npm ci` and `npm run setup -- --frontend-qa` bring the
dependencies back (`../scripts/restore-runtime.ps1` runs those two, as a wrapper until 4.0).

Environment overrides:

```text
AI_DEV_VAULT_ROOT   the vault the server reads and writes (optional; default: the vault around the
                    server, a clone's docker/public-seed, $AI_DEV_HOME/vault for a package or the
                    Windows install, /data/ai-dev-system in Docker)
AI_DEV_HOME         runtime-data root (default ~/.ai-dev)
AI_DEV_PROFILES     capability profiles listed to the client (default: every one an agent gets;
                    the `profiles` setting in config.json fills it when unset; ../docs/CAPABILITIES.md)
AI_DEV_STATE_ROOT   task/outcome/pilot state (default $AI_DEV_HOME/state)
AI_DEV_SEARCH_INDEX_DIR   search index dir (default $AI_DEV_HOME/cache/search-index)
AI_DEV_FRONTEND_QA_ARTIFACT_ROOT   QA artifacts (default $AI_DEV_HOME/artifacts/frontend-qa)
AI_DEV_PYTHON       python for the two UI UX Pro Max tools (default: python3; python on Windows)
BGE_M3_ONNX_DIR     ONNX embedding model dir (default $AI_DEV_HOME/models/bge-m3-onnx)
AI_DEV_MODEL_MIRROR Hugging Face mirror tried first for the model (HF_ENDPOINT format)
AI_DEV_MODEL_MANIFEST  another pinned manifest instead of models/bge-m3.manifest.json
AI_DEV_OFFLINE      1 forbids model downloads; `npm run model -- import` still works
HTTPS_PROXY / HTTP_PROXY / NO_PROXY   honoured by the model download
AI_DEV_DAEMON       0 serves the client in its own process instead of the shared daemon
AI_DEV_IDLE_TIMEOUT_MS   how long the daemon stays without a client (default 1800000; 0 = until stopped; at most 2147483647, about 24.8 days)
AI_DEV_DAEMON_START_TIMEOUT_MS   how long `ai-dev mcp` waits for a daemon it started (default 20000)
```

`AI_DEV_HOME` is the runtime folder itself: `state/`, `cache/` and `models/` sit directly in
it. Earlier versions put them one level deeper, in `$AI_DEV_HOME/.ai-dev`. The server, `npm run setup` and the `ai-dev` CLI move such a tree up when they start:
files missing at the new place are moved, identical ones dropped, JSONL ledgers appended, and a
file that differs on the two sides stays where it was. `npm run doctor` names what is left in its
`runtime_home` check, and `state/runtime-home-migration.json` records every run that found something. `AI_DEV_HOME`
set to your home directory itself keeps meaning `~/.ai-dev`, as it did. Hooks installed into a
repository by an earlier version still look for the old tree; run `install_agent_hooks` again
to update them.

## Docker

The repository ships a local-only, non-root Docker image: the distribution `npm run dist` builds,
with the clean public skill seed, the registry and search index built from it, persistent local
state in a volume, and no network listener (a `-browser` variant adds Chromium for Frontend QA).
Clients run it themselves, one `docker run -i --rm …` per session, which answers the MCP handshake
in about a second. It is built from a generated allowlist context rather than from the Vault or
repository root.

```bash
npm run docker:prepare && npm run docker:audit
docker build --tag ai-dev-system:local ../.docker/build-context
npm run docker:smoke -- --image ai-dev-system:local
```

Passwords, project contexts, task history, models, caches, logs, backups, `.codex`, `.ai-dev`,
`.obsidian`, and Git history are excluded by policy and audited before every build. Repositories
are visible only when the user mounts a chosen projects folder: at its own path on macOS and Linux,
under `/workspace` on Windows.

See [the complete Windows, macOS, Linux, client configuration, Compose, BGE-M3, and GHCR guide](../docker/README.md).

## Acceptance

```bash
npm run check         # the gate, once
npm run acceptance    # the gate, ten times in a row
```

The gate runs the static modularity checks, the unit tests with their coverage thresholds, the
security checks, real stdio negotiation and the lifecycle smoke. With the local model installed,
`node bin/ai-dev.mjs doctor --dense-smoke --search-eval` adds the dense checks and the golden
search suite. `../scripts/run-acceptance.ps1` is a wrapper over `npm run check` until 4.0.

## Distribution

```bash
npm run dist          # ../dist/ai-dev/: the package folder, with its production dependencies
npm run dist:pack     # and ../dist/ai-dev-system-<version>.tgz beside it
```

What ships is `distribution.allowlist.json` — the same list `npm run docker:prepare` builds the
image's context from. The folder holds `distribution.json` (every file with its sha256), the
package's `package.json` and the server's lockfile as `npm-shrinkwrap.json`; `prepack` checks the
folder against the list, and `dist:pack` checks the tarball, unpacked, byte for byte. Nothing is
published from here.

The desktop app's packages are made from the same folder: `cd ../desktop && npm run dist:win`
(`dist:linux`; `dist:mac` too, though macOS is in development and its `.dmg` is not released) adds
the dependencies for the target, a pinned Node and `bundle.json`, and builds the NSIS installer, the
AppImage and `.deb`, or the `.dmg` and `.zip`
([The desktop install](../docs/DESKTOP.md#the-desktop-install)). `ai-dev uninstall [--clients]
[--data] --yes` is what the Windows uninstaller runs, and what a person runs before removing the app
on macOS or Linux: it stops the daemon and removes the runtime copies the
app made in `<runtime home>/app` and their link, the clients' entries that run them with
`--clients`, and the runtime home itself with `--data` — only when what is at its top, and inside
its `models`, `cache` and `backups` folders, is AI Dev's own, and not while a runtime copy is in
use. Its exit status tells the uninstaller what is left: 3 files an AI client still runs, 4 the
data kept.

## Local Operations

Everything a person does with the server is one command line, `bin/ai-dev.mjs` — from a clone
`npm run ai-dev -- <command>`, or `ai-dev <command>` after `npm link`:

```bash
ai-dev                           # at a terminal: a menu over everything below you set up and change
ai-dev setup [--yes] [--model] [--frontend-qa] [--clients=all|<names>]
ai-dev clients list | install | remove | doctor [--clients=<names>] [--dry-run] [--json]
ai-dev settings [list | get <name> | set <name> <value> | reset <name>... | path] [--json]
ai-dev skills search | groups | browse | show | mine | add <folder> | new <name> <description> | remove | import <url> | rebuild | check
ai-dev rules list | add <id> | on | off | remove | hooks [install] | packs | install [--project <path>]
ai-dev servers [--project <path>] [--mine]
ai-dev status [--quick] [--json]
ai-dev model status | install | import <path> | verify | remove | doctor
ai-dev mcp                       # what a client starts: its stdio, bridged to the daemon
ai-dev daemon start | stop | status | run [--json]
ai-dev doctor [--dense-smoke] [--search-eval]
ai-dev dashboard | galaxy [scope...] | reindex | refresh [flags] | distribution
ai-dev help [command]
```

Exit codes: 0 done, 1 failed, 2 wrong usage, 130 stopped with Ctrl-C. `npm run setup`,
`doctor`, `clients:install`, `model`, `dense:doctor`, `dashboard`, `galaxy`, `refresh`,
`backup` and `distribution` run the same commands. The 2.x paths still work until 4.0, with a
note on stderr where they were documented: `node scripts/ai-dev.mjs <command>`,
`scripts/start-local.ps1` (now `ai-dev mcp`), `scripts/install-local-mcp-clients.mjs [--apply]`
(now `ai-dev clients install`; as before, a dry run without `--apply`, and the four clients 2.x
wrote — Cursor, Gemini, VS Code, Claude Code — unless `--clients` names others).

`ai-dev clients install` writes one entry, `ai-dev`, into Claude Code, Claude Desktop (and its
Microsoft Store copy), Cursor, VS Code, Codex and Gemini: the absolute path of this Node, this
clone's `bin/ai-dev.mjs` and `mcp`, plus `AI_DEV_VAULT_ROOT` for a vault install and
`AI_DEV_HOME` when it names a runtime folder of its own. Each file is
edited in place — other servers, comments and formatting stay byte for byte — written through a
temp file and a rename, and backed up as `<file>.backup-<time>`; `ai-dev-system`, the 2.x
name, is removed. `clients doctor` starts each entry's command and checks that it answers
`initialize` with instructions; `clients remove` gives an untouched file back as it was, less any
`ai-dev` or `ai-dev-system` entry the install replaced (its backup keeps it). Restart or reload
each client after installation. Any model selected inside an MCP-capable client can use
the same tools; a raw model endpoint still needs an MCP-capable host.

`ai-dev mcp` does not serve the client itself: it hands the client's stdin and stdout to the
daemon, one warm server for every client of this user, and starts it when none runs — so the
index and the model are in memory once, not once per client, and the state has one writer. The
handshake passes through, instructions included. Each client's session runs in that client's own
environment — its PATH, proxy and certificates — as its own process did in 2.x. Clients whose
code, Node or data differ (another copy of AI Dev, another Node, another `AI_DEV_VAULT_ROOT`) get a
daemon each; two spellings of one folder are one.
A daemon that dies is replaced at the client's next request (the request it was running gets an
error that says so); one that cannot start leaves the client served in its own process, with the
reason on stderr. A client that writes its requests and closes its input still gets every answer.
`ai-dev daemon status` shows the pid, the sessions, the memory, the log
(`~/.ai-dev/logs/daemon.log`) and any other daemon of the runtime home with why it is another;
`stop` stops them all, and the next request of a client starts a new one. The channel — a random
address per start, a secret in `run/daemon-<build>.json` that each side proves it holds — is
described in [docs/SECURITY.md](docs/SECURITY.md#the-daemon). `AI_DEV_DAEMON=0` in a client's
environment, `npm start`, and the 2.x entry `node src/server.mjs` serve in the client's own
process, as 2.x did.

The shipped runtime profile is local stdio. A future remote profile is configuration scaffolding,
not an enabled network server: remote mode remains blocked until TLS, authentication, allowlists,
rate limits, and threat review are implemented.

## Backup And Recovery

```bash
node bin/ai-dev.mjs backup before-upgrade
node bin/ai-dev.mjs restore <backup.zip> --confirm --to <empty-folder>
```

On every system and in every layout: the vault this install reads and AI Dev's state, every file
with its sha256. Backups contain local vault content, including owner-kept private notes. They
remain local and must not be pushed to a public repository. The 2.x PowerShell scripts are
wrappers over these commands until 4.0.

See `docs/RECOVERY.md`.
