# AI Dev MCP System

> 🇬🇧 English (this page) · 🇷🇺 Русская версия: [README.ru.md](README.ru.md)

A local system for developing with AI agents. It exposes MCP tools for repository
context, a knowledge base and skill library, search, quality gates, and verifiable
task tracking. The server speaks `stdio`: it opens no network port and needs no
remote MCP server.

You connect an MCP-compatible client that already has a model selected — Claude
Code / Claude Desktop, Cursor, VS Code with MCP, Gemini CLI / Code Assist, Codex,
or any other MCP host — not a model directly. The same local configuration works
for all of these clients.

## What is included

- a local Node.js MCP server;
- a knowledge base, project context, and a managed skill library;
- hybrid search: SQLite FTS, sparse retrieval, and an optional local BGE-M3 model;
- a task lifecycle: `begin_task`, `checkpoint_task`, `verify_task`, `complete_task`,
  a completion-statement linter that refuses a report the checks do not back, and a
  pull request description built from the evidence it collected;
- [snapshots of a task's working tree](#undoing-a-turn) after every checkpoint, and a
  reversible rollback to any of them;
- [epics](#breaking-a-task-up): one task broken into children with an order between
  them, and a parent that cannot close while a child is open;
- a quality gate, security checks, and Frontend QA with Playwright / Chromium;
- [memory across sessions](#memory-and-learning): handoffs, decisions, and learned instincts;
- [agent hooks](#hooks) for Claude Code and Cursor that guard commands and file writes,
  with the project's own rules edited through checked tools rather than by hand;
- [an inventory of the MCP servers](#what-your-agents-are-wired-to) your agents are wired to,
  and the credentials sitting in those config files;
- a Docker image for teams: no personal vault, passwords, tokens, projects, or task history.

## Requirements

For the Docker path:

- Docker Desktop (Windows / macOS) or Docker Engine (Linux); bootstrap can install it;
- Docker must have access to the project folder you choose.

To run from source you additionally need Node.js 22.12+ and npm. On Windows you can
use the bundled runtime described in the [server README](ai-dev-mcp-server/README.md).
From the clone root:

```bash
cd ai-dev-mcp-server
npm ci --ignore-scripts --no-audit --no-fund
npm run setup
```

`npm run setup` builds the three things a clone does not ship — the skill
registry, the search index and the routing benchmark — and prints the health
check. Add `--frontend-qa` for the QA runner's dependencies, `--dense` for the
local BGE-M3 model and the embeddings built with it (~2.3 GB); neither runs
unless asked. No Obsidian vault is needed: without one the server reads the
bundled seed and its helper trees from the repository itself.

## One command on Windows

After `git clone`, open PowerShell in the clone root and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

The script creates an isolated `AI-Dev-Projects` folder in your home directory,
installs Docker Desktop and Node.js LTS via `winget` if they are missing,
pulls the published image, verifies MCP, and registers the local `ai-dev` server
with Codex, Cursor, Gemini, VS Code, and Claude. On Windows it also installs a
launcher-only copy at `C:\ProgramData\AI-Dev-System\run-mcp.ps1`, which avoids
encoding problems when the clone path contains non-ASCII characters. That folder
never receives projects, the vault, tokens, or passwords. For Claude Desktop it
additionally creates a small `ClaudeMcpProxy.exe` in the same folder: it answers
the MCP initialization handshake before Docker has started, so Claude's short
startup timeout is satisfied, and then transparently forwards the session to the
local Docker container.

Run the first invocation **as administrator** only if Docker Desktop or Node.js
are not yet installed: `winget` and Docker may request elevation. If Docker
Desktop is already installed, a normal PowerShell session is enough.

For a different project folder and a subset of clients:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 `
  -ProjectPath "D:\Projects" `
  -Clients "codex,cursor,vscode"
```

The path is stored only in the local settings of the selected clients. No tokens,
passwords, folder contents, or your profile are written to Git. Restart the AI
client afterwards.

## One command on macOS and Linux

If Docker is already installed and running:

```bash
sh ./bootstrap.sh
```

If Docker is not installed yet, one command covers every supported system:

| System | Command after `git clone` |
| --- | --- |
| macOS | `sh ./bootstrap.sh --install-prerequisites` |
| Debian / Ubuntu | `sh ./bootstrap.sh --install-prerequisites` |
| Fedora | `sh ./bootstrap.sh --install-prerequisites` |
| Arch Linux / Manjaro | `sh ./bootstrap.sh --install-prerequisites` |

On macOS the script uses Homebrew: it installs Homebrew with the official
installer if needed, then runs `brew install --cask docker`, starts Docker
Desktop, and waits for the engine. The first launch of Docker Desktop may require
accepting the licence and confirming privileged settings in the app window.

On Linux it uses `apt`, `dnf`, or `pacman`, enables the Docker service, and adds
the current user to the `docker` group. You then need to log out and back in and
re-run the command.

Bootstrap needs no Node.js on the host: it configures MCP clients from a
throwaway `node:24` container. By default it pulls
`ghcr.io/stonebridgeway/ai-dev-system:latest`, and the working folder is created
as `~/AI-Dev-Projects` and mounted into the container as `/workspace`.

So that Claude Desktop and other clients do not abort Docker's slow cold start,
bootstrap creates a helper container `ai-dev-system-runtime-$(id -u)`. It runs
with no network, a read-only filesystem, no Linux capabilities, and
`no-new-privileges`; it is granted access only to the system's named volume and
the chosen project folder. The MCP process itself starts through a fast
`docker exec`, and the launcher completes the protocol handshake immediately. The
container comes back automatically after a Docker restart thanks to
`restart=unless-stopped`.

For a different project folder and a subset of clients:

```bash
sh ./bootstrap.sh --project-path "$HOME/Dev" --clients "codex,cursor,vscode"
```

Re-running the same command safely updates only the managed runtime container.
The named volume, indexes, knowledge base, and project files are left intact.
Check the runtime with:

```bash
docker ps --filter "label=ai-dev.system.runtime=true"
```

To develop the image itself, use explicit local mode:

```bash
sh ./bootstrap.sh --build-local
```

## Quick start: Docker

### 1. Get the image

```bash
docker pull ghcr.io/stonebridgeway/ai-dev-system:latest
```

Or build the image from a clone of the repository:

```bash
cd ai-dev-mcp-server
npm ci --ignore-scripts --no-audit --no-fund
npm run docker:prepare
npm run docker:audit
npm run docker:build
npm run docker:smoke -- --image ai-dev-system:local
```

The build always uses the temporary allowlisted context `.docker/build-context`,
never the repository root or an Obsidian vault. Do not point the Docker context
at a vault root.

### 2. Choose a working folder

Create or choose a folder that contains only the repositories the agent is
allowed to work on — for example `C:\Dev` on Windows or `$HOME/Dev` on
macOS / Linux. This folder is mounted into the container as `/workspace`.

Do not use a personal vault, your entire home directory, or a folder with secrets
or backups.

### 3. Verify the local launch

Windows:

```powershell
$env:AI_DEV_IMAGE = "ghcr.io/stonebridgeway/ai-dev-system:latest"
$env:AI_DEV_PROJECT_PATH = "C:\Dev"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\docker\run-mcp.ps1
```

macOS / Linux:

```bash
export AI_DEV_IMAGE="ghcr.io/stonebridgeway/ai-dev-system:latest"
export AI_DEV_PROJECT_PATH="$HOME/Dev"
sh ./docker/run-mcp.sh
```

The process waits for MCP messages on standard input. That is expected: end the
check with `Ctrl+C`, then wire the launcher command into an MCP client.

## Connecting AI agents

In every case, replace `C:\ABSOLUTE\PATH` with the absolute path to your clone of
this repository, and `C:\Dev` with the folder that holds your projects. Do not
commit these values to Git.

### Codex

Add to your user `config.toml`:

```toml
[mcp_servers.ai-dev]
command = "powershell.exe"
args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\ABSOLUTE\\PATH\\docker\\run-mcp.ps1"]
env = { AI_DEV_IMAGE = "ghcr.io/stonebridgeway/ai-dev-system:latest", AI_DEV_PROJECT_PATH = "C:\\Dev" }
startup_timeout_sec = 120
tool_timeout_sec = 3600
```

On macOS / Linux use `command = "/bin/sh"` and pass the absolute path to
`docker/run-mcp.sh` in `args`. Also set the name bootstrap created in `env`:
`AI_DEV_RUNTIME_CONTAINER = "ai-dev-system-runtime-UID"`, where `UID` is the
output of `id -u`. The automatic installer does this for you. Restart Codex and
confirm that the `ai-dev` server appears in the MCP tool list.

### Cursor, Claude Desktop, Claude Code, and Gemini

These clients use JSON with an `mcpServers` property. Add or merge the block below
into their existing configuration:

When you run `bootstrap.ps1 -Clients claude`, the installer updates both local
Claude files: `%USERPROFILE%\.claude.json` for Claude Code and
`%APPDATA%\Claude\claude_desktop_config.json` for Claude Desktop. Existing servers
are preserved, and the file being changed is backed up first. For the Microsoft
Store build of Claude, the installer also updates the sandboxed app profile under
`%LOCALAPPDATA%\Packages\Claude_*`. On Windows, do not replace the
automatically installed Claude configuration with the example below: it uses
`C:\ProgramData\AI-Dev-System\ClaudeMcpProxy.exe` for a fast Docker-MCP start.
On macOS / Linux, bootstrap similarly stores `AI_DEV_RUNTIME_CONTAINER` in the
configuration and wires the fast launcher; there is no need to edit the Claude
files by hand after bootstrap.

```json
{
  "mcpServers": {
    "ai-dev": {
      "command": "powershell.exe",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\ABSOLUTE\\PATH\\docker\\run-mcp.ps1"
      ],
      "env": {
        "AI_DEV_IMAGE": "ghcr.io/stonebridgeway/ai-dev-system:latest",
        "AI_DEV_PROJECT_PATH": "C:\\Dev"
      }
    }
  }
}
```

A minimal template with no project access is in
[docker/mcp-config.example.json](docker/mcp-config.example.json). After changing
the configuration, restart the client completely. In Claude Code and the Gemini
CLI the configuration can be added through their own MCP management command, but
the launch command and environment variables stay the same.

### VS Code

Create `.vscode/mcp.json` in a specific working repository, or add the same server
to your VS Code user MCP settings:

```json
{
  "servers": {
    "ai-dev": {
      "type": "stdio",
      "command": "powershell.exe",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\ABSOLUTE\\PATH\\docker\\run-mcp.ps1"
      ],
      "env": {
        "AI_DEV_IMAGE": "ghcr.io/stonebridgeway/ai-dev-system:latest",
        "AI_DEV_PROJECT_PATH": "C:\\Dev"
      }
    }
  }
}
```

Reload the VS Code window. Inside the container, mounted repository paths start
with `/workspace`; for example, call `begin_task` with `/workspace/my-project`.

## Working with the agent

1. Open the target repository in your MCP client.
2. Give the agent a concrete task and a path under `/workspace`.
3. For substantive work the agent calls `begin_task`, reviews the compiled
   context, and loads no more than three routed skills.
4. After changing code the agent records progress with `checkpoint_task`, runs
   `verify_task`, and only calls `complete_task` with current evidence.
5. Both report tools lint what they are told. A rationalization the checks do not
   back — "pre-existing issue", "skipping tests for now", "should work", "works on
   my machine" — is refused with the rule, the check behind it and what is missing;
   `.ai-dev/policy.json` turns the linter off or waives one rule where the reason is
   real and written into the report.
6. Each checkpoint also snapshots the working tree that turn produced, so a turn that
   went wrong can be undone (see below).
7. `complete_task` writes the pull request description from that evidence into
   `.ai-dev/pr/<task_id>.md` — goal, acceptance criteria with their status,
   changed files by group, the checks that ran, decisions, and whatever is still
   outstanding — filling the repository's own pull request template when it has
   one. `prepare_pull_request` builds the same text at any point. Neither pushes
   the branch nor opens the pull request: both commands are returned as text.

Example request to the agent:

```text
Use the ai-dev MCP server. Begin a task for /workspace/my-project:
add CSV export for the report, cover the change with tests, and run verify_task.
```

### Breaking a task up

A task too big for one arc becomes an epic. `decompose_task` turns it into a
parent and a set of children, each opened through `begin_task` — so a child
routes its own skills, compiles its own context pack, carries its own acceptance
criteria, and every other tool works on it unchanged.

```text
Use the ai-dev MCP server. Decompose task-2026... into: extract the parser;
wire it into the router (depends on the first); document the new module
(depends on the second).
```

A child may wait for its siblings through `depends_on`, named by key or by
position. A reference to nothing, a child waiting for itself, and a ring of
children each waiting for the next are all refused before anything is created —
an order that cannot be worked is better rejected than opened.

`epic_status` reads the family back: what each child is waiting for, how far the
whole thing has come, and the one child to work next (something already in
progress before something merely ready). Ask it about a child and it answers
with the parent's epic. `complete_task` on the parent is refused while any child
is open, or while a child's record has gone missing — an epic closes last, on
evidence that still exists.

GitHub Issues are not part of this. ECC coordinates epics through issues and
labels; this server tracks tasks itself and works offline.

### Undoing a turn

`checkpoint_task` records the whole working tree of the task — tracked changes, staged or
not, plus the files the agent created — as a snapshot, and `snapshot_task` takes one on
demand before something risky. `list_task_snapshots` shows what can be returned to, and
`rollback_task` returns to it: the snapshot's files go back to their recorded content and
the files that appeared since are removed.

Nothing is written to your branch, your stash or your index. A snapshot is a single commit
object no branch points at, held by a ref under `refs/ai-dev/snapshots/<task_id>/`, and
`.gitignore` decides what it carries, so dependencies and build output are neither stored
nor touched. A rollback snapshots the state it replaces first, so it can itself be rolled
back. `complete_task` deletes the task's snapshots once the work is closed.

## Memory and learning

The server keeps three kinds of memory so a new session does not start from
nothing. All of it is text you can read, and none of it is written without an
explicit call.

| Tool | What it stores | Where |
| --- | --- | --- |
| `save_session` | A structured handoff: what you are building, what worked with evidence, what failed and why, file states, blockers, and the exact next step. | `~/.ai-dev/state/sessions/`, projected to `.ai-dev/context/handoff.md` |
| `resume_session` | Nothing — it reads the latest handoff back as a briefing: what not to retry, blockers, next step, open tasks, git state, and relevant instincts. | — |
| `record_decision` | A numbered ADR: title, context, decision, alternatives, consequences. | `.ai-dev/decisions/`, versioned with the code |
| `record_instinct` | One learned behaviour as "when *trigger*, *action*", with a confidence that rises on repeat observation and decays with time. | `~/.ai-dev/state/instincts.json` |
| `context_budget_status` | Nothing — it estimates a task's static context against the model window and says when compacting is safe. | — |
| `list_sessions` | Nothing — it lists the handoffs a repository has, newest first, marking the unconfirmed hook drafts and the sessions whose observation log is still on disk. | — |
| `propose_instincts` | Candidate instincts read out of one session's observation log, stored as `proposed` until confirmed. | `~/.ai-dev/state/instincts.json` |

Decisions, the newest handoff, and instincts above 70% confidence are folded
into the context pack that `begin_task` compiles, so the next session sees them
without asking. Sessions and instincts live in your home directory (per user);
decisions live in the repository (per project, reviewable in a pull request).
Sessions and instincts are keyed by repository, not by directory: a task worktree
created by `begin_task_in_worktree` and the main checkout read and write the same
memory, while a task stays bound to the working tree it was started in.

The `learn_from_task` prompt closes the loop: run it after finishing a task and
the agent reviews the work, records durable patterns as instincts, architectural
choices as decisions, and a handoff if the work continues elsewhere. It is
deliberately conservative — single occurrences, code, and secrets do not belong
in long-term memory.

`propose_instincts` is the other half of that loop, for the sessions where
nobody ran the prompt. The session-end hook leaves an observation log — what you
said, what tools ran with what, which calls came back as errors — and the tool
reads one: the corrections you made, the rules you stated, an error that recurred
and the call that finally cleared it, and the commands and pairs of commands the
session kept repeating. What comes back is candidates, not conclusions. Each one
quotes what was observed, is stored with status `proposed`, is never injected
into a context pack, and becomes a real instinct only through
`update_instinct(action: "confirm")` — or goes away with `retire`. Run it against
a session by id, or leave the id out for the newest one; `dry_run` shows the
candidates without storing any.

`list_instincts` shows what has been learned (`status: "proposed"` for the
candidates), `update_instinct` confirms or
retires one, and `evolve_instincts` clusters mature instincts into skill drafts
and promotes those seen across several projects to global scope.

## Hooks

`install_agent_hooks` wires the server's guard rails into the agent itself, so
they apply to every action rather than only to the tools the agent chooses to
call:

```text
Use the ai-dev MCP server. Call install_agent_hooks for /workspace/my-project
with targets ["claude"] and profile "standard".
```

It writes self-contained scripts into `.ai-dev/hooks/`, a policy file at
`.ai-dev/policy.json`, and registrations into `.claude/settings.json` (Claude
Code) and/or `.cursor/hooks.json` (Cursor). Existing settings are merged, not
replaced: only previous AI Dev entries are rewritten. Re-running refreshes the
scripts and keeps your policy rules. `agent_hooks_status` reports what is
installed.

The hooks block a command before it runs (git-hook bypasses, destructive and
publishing commands), block a write before it lands (secret-bearing paths,
secrets in content, weakened linter configuration), format edited files, inject
the last handoff and open tasks at session start, distil the transcript into a
session record at session end, record what each turn spent, and advise on
compaction. Any hook error exits zero, so a broken hook never wedges the agent.

What the session-end hook captures is a draft, not a handoff: its fields are
heuristics over the transcript, so `resume_session` shows such a record flagged
unconfirmed, and `save_session` with `confirm_hook_draft: true` is what turns it
into a real one — your fields win, the draft fills the rest, and the draft is
dropped.

The cost-capture hook reads the same transcript for a different reason: after
every response it sums the tokens of the assistant messages that arrived since
the last one and appends them to the usage ledger, per model. It records tokens,
not money — `usage_report` prices them at read time from published Anthropic
rates and shows today, yesterday, the last seven days, and the per-model and
per-task totals. Prices move, so `model_rates` in `.ai-dev/policy.json`
overrides any of them (USD per million tokens), and a model with no rate is
listed as unpriced rather than counted as free.

Three profiles:

- `minimal` — the command and file guard, session capture and cost capture.
  Nothing else runs.
- `standard` — the default: everything above, including formatting, session
  start injection, the compaction advisor, and the end-of-response check.
- `strict` — the same set plus extra review warnings before `git push` and
  `git commit --amend`, and fact forcing.

Fact forcing is the strict profile's one refusal that is not about danger. The
first edit of a file in a session is refused until the agent has written the
facts behind it, and the first destructive command until it has written the way
back:

```text
FACTS src/router.mjs
importers: src/app.mjs and src/server.mjs
api: adds a `resolve` export, nothing removed
data: reads the route table in config/routes.json
instruction: "make the router resolve nested paths"
```

The refusal quotes that block, the agent writes it in the turn that repeats the
edit, and the retry goes through; the file then stays grounded for the rest of
the session. The gate reads the transcript, so where there is none it judges
nothing, and it stops refusing after three refusals in one session rather than
arguing. `fact_force` in the policy turns it on anywhere, or off under strict,
and `exempt_globs` keeps it away from paths where it has nothing to ask.

`targets: ["git"]` installs two more, for everyone rather than for one client:
`install_agent_hooks` writes `.ai-dev/git-hooks/{pre-commit,pre-push}` and points
`core.hooksPath` at them, so a commit made from an editor, a script or a terminal
meets the same rules. `pre-commit` refuses a staged secret, merge-conflict
marker, focused test or left-behind `debugger`; `pre-push` says when the active
task has no verification or its latest one failed. A `core.hooksPath` someone
else set is reported, never taken over, and every hook in `.git/hooks` that
would stop running is named — git consults one hooks directory, not two.

`.ai-dev/policy.json` is where you tune it without touching the scripts:
`allow_config_edits`, `format_on_edit`, compaction thresholds, `model_rates`,
`completion_claims` (the completion-statement linter: `enabled`, and `waivers` of
`{ rule, reason, expires }`), `fact_force` (`enabled`, `files`, `bash`,
`expiry_minutes`, `max_denials`, `max_entries`, `exempt_globs`), `git_hooks`
(`pre_commit` and `pre_push`, each `block`, `warn` or `off`), and a list of your
own rules:

```json
{
  "profile": "standard",
  "rules": [
    {
      "id": "block-prod-migrations",
      "event": "bash",
      "pattern": "(migrate|migration).*(--prod|production)",
      "action": "block",
      "message": "Production migrations need explicit human approval."
    }
  ]
}
```

`event` is `bash`, `file`, or `all`; `action` is `block` or `warn`.

### Rules without hand-editing JSON

A rule nobody proved fires is a rule that silently does nothing, and the guard
says nothing about one: a pattern that does not compile, an event it never
evaluates, or an `action` it does not know are skipped or quietly downgraded to a
warning. So the rules block has tools of its own:

```text
Use the ai-dev MCP server. Call upsert_policy_rule for /workspace/my-project with a
rule that blocks `terraform destroy`, and an example it must match.
```

`upsert_policy_rule` compiles the pattern exactly as the guard does
(case-insensitively), refuses one that cannot work — including a quantified group
holding an unbounded quantifier, which would stall the guard on a long line —
refuses a second rule that fires on the same text, and refuses a new or changed
pattern that does not match the `example` you pass. It stores the example on the
rule, so `list_policy_rules` can re-run it later and tell you a rule a hand edit
disarmed; `counter_example` is checked the same way, against a pattern that grew
too broad. Updates are patches, so `{ "id": "warn-eval", "enabled": false }`
disables a rule and `remove_policy_rule` deletes one. `agent_hooks_status` lists
every rule with what the guard would actually do with it. The guard re-reads the
file on every call, so a change is live without restarting the client.

## What your agents are wired to

Every client keeps its own list of MCP servers, and each entry is a program that
starts with the editor and answers tool calls with your credentials.
`list_mcp_servers` reads all of them — `.mcp.json`, `.claude/settings.json` and
`settings.local.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
`.gemini/settings.json`, `.codex/config.toml` — and reports one entry per server:
which files declare it, over which transport, which environment variables it
substitutes and whether they are set, and whether Claude Code starts it without
asking.

A credential written out in a config file is a `block` finding, masked out of the
report so it is not repeated into the next ticket: the file is in the repository,
so the value is in every clone and needs rotating, not deleting. Plain HTTP to a
remote endpoint, `npx -y` with no pinned version, a server that starts through a
shell, an entry no client can start, a config that cannot be parsed, and the same
server name defined differently in two files are warnings. Pass
`include_user_scope: true` to include your own `~/.claude.json` (with its
per-project block), `~/.cursor/mcp.json`, `~/.gemini/settings.json` and
`~/.codex/config.toml`; it is off by default, because those files are yours
rather than the repository's.

## Local data and security

The image contains only the audited public seed: rules, prompts, quality gates,
allowlisted skills, and the runtime. It does not include:

- passwords, tokens, `.env` files, keys, or user configurations;
- a personal Obsidian vault, `.codex`, `.ai-dev`, Git history, or local caches;
- `02-knowledge/Projects`, `02-knowledge/Task Runs`, indexes, logs, or backups;
- the source or context of your projects;
- the BGE-M3 weights.

Data the container creates is stored in the local Docker volume
`ai-dev-system-data`. Updating the image does not overwrite that volume. By
default the container runs with no network, as a non-root user, with a read-only
root filesystem, no Linux capabilities, and `no-new-privileges`.

If a project genuinely needs internet access during verification, set
`AI_DEV_DOCKER_NETWORK=bridge` deliberately for that run only.

## Docker Compose and BGE-M3

For Compose, copy `docker/compose.local.example.yaml` to
`docker/compose.local.yaml`, set a local `AI_DEV_PROJECT_PATH`, and run:

```bash
docker compose -f docker/compose.yaml -f docker/compose.local.yaml run --rm -T ai-dev-mcp
```

`compose.local.yaml` and `docker/.env` are Git-ignored because they can contain
local paths.

For more accurate semantic search you can build a variant with BGE-M3:

```bash
docker build --build-arg INSTALL_BGE_M3=1 --tag ai-dev-system:bge .docker/build-context
```

The model weights are not embedded in the image. Mount your own local folder via
`AI_DEV_MODEL_PATH`; the launcher attaches it read-only as `/models/bge-m3`. See
[the server README](ai-dev-mcp-server/README.md#semantic-search-bge-m3) for how to
download the weights when running from source.

## Publishing for a team

The [docker-publish.yml](.github/workflows/docker-publish.yml) workflow checks the
privacy policy, rebuilds the allowlisted context, runs the MCP smoke test, and
publishes `linux/amd64` and `linux/arm64` images to the GitHub Container Registry
with an SBOM and provenance.

After the first push:

1. Open the package in GitHub and set its visibility to `private` / `internal`
   for a team, or `public`.
2. Make sure teammates can read GitHub Packages.
3. Give teammates the address `ghcr.io/stonebridgeway/ai-dev-system:latest` and
   this README.
4. Each teammate sets their own local project folder via `AI_DEV_PROJECT_PATH`;
   other people's files never enter the image or Git.

## Arch / AUR and Homebrew

After publication in AUR, install on Arch Linux / Manjaro with:

```bash
yay -S ai-dev-system-git
ai-dev-system --install-prerequisites
```

The package follows `main`. It can also be built from this clone:

```bash
cd packaging/arch
makepkg -si
ai-dev-system --install-prerequisites
```

The AUR package name is `ai-dev-system-git`. Publishing requires a separate AUR
account and the maintainer's SSH repository.

On macOS, after the Homebrew tap is published:

```bash
brew tap stonebridgeway/tap
brew install ai-dev-system
ai-dev-system --install-prerequisites
```

The formula installs the stable `v1.0.0` release. Maintainer publishing and
release-update details are in [packaging/README.md](packaging/README.md).

## Verification and diagnostics

Before a release, from `ai-dev-mcp-server` run:

```powershell
npm run check
npm run docker:prepare
npm run docker:audit
npm run docker:smoke -- --image ai-dev-system:local
```

For a full sweep of the whole suite:

```powershell
..\scripts\run-acceptance.ps1
```

If Docker Desktop cannot pull the base image behind a VPN or corporate DNS,
configure a proxy / DNS in Docker Desktop. Do not put proxy passwords in the
Dockerfile, Git, build args, or project files. An image that is already built
runs with no internet access.

Compose, macOS / Linux, BGE-M3, and GHCR details: [docker/README.md](docker/README.md).
Architecture and the full tool list: [ai-dev-mcp-server/README.md](ai-dev-mcp-server/README.md).

## Contributing

The improvement plan and the ECC-derived upgrade notes (rationale, wiring, tool examples) live in
[docs/ecc-upgrades/](docs/ecc-upgrades/README.md); start with [PLAN.md](docs/ecc-upgrades/PLAN.md).


See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, how the test
suite is split between a standalone checkout and a full vault, and the checks CI
runs. Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
Security reports: [SECURITY.md](SECURITY.md).

## Licences

See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
