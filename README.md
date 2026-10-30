# AI Dev System

[![Version 3.0.0](https://img.shields.io/badge/version-3.0.0-2f6feb)](CHANGELOG.md)
[![Windows · Linux](https://img.shields.io/badge/platforms-Windows%20%C2%B7%20Linux-555)](docs/INSTALL.md)
[![Node 22.16+](https://img.shields.io/badge/node-22.16%2B-3c873a)](docs/INSTALL.md#one-command-with-node-npx)
[![MCP](https://img.shields.io/badge/MCP-stdio-6b4fbb)](https://modelcontextprotocol.io)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial-c2410c)](LICENSE)

> 🇬🇧 English (this page) · 🇷🇺 Русская версия: [README.ru.md](README.ru.md)

**A local layer for AI coding agents: durable memory of your project, the skills a
task actually needs, a controlled task lifecycle, and a completion the agent has
to prove.**

It runs on your machine over `stdio` — no network port, no remote server, no
account. You point an MCP client you already use (Claude Code, Claude Desktop,
Cursor, VS Code, Codex, Gemini) at it, and the agent in that client gains the
four things below.

![The AI Dev desktop app: a project with its tasks, decisions and handoffs](docs/images/app-projects.png)

---

## What's new in 3.0

3.0 changes how AI Dev is installed and how an AI client reaches it — not what an agent can do
with it. The server is the one 2.x users know; what is new is the way in.

- **Two products from one system.** A **desktop app** for a person at their own computer, and a
  **server for AI agents configured entirely from the terminal** — `ai-dev` alone opens a menu over
  every setting, and the same commands work from a script and over SSH.
- **No Python.** Search, its index and hybrid ranking run in Node; the local BGE-M3 model is an ONNX
  export, downloaded with progress and resume and checked file by file.
- **One daemon for every client.** The index and the model are loaded once: three clients took
  528 MB, and take 391 MB.
- **Answers an agent can afford.** The task tools answer with what changed instead of the whole
  record every time: the task in [the demo](docs/DEMO.md) costs 33 KB of tool output instead of
  242 KB.
- **Docker as a server mode.** Each session is its own container, about a second to start; the
  image is 716 MB (2.x: 1.84 GB).
- **614 curated skills** instead of 3,228 — the connectors cut to the ones developers use, with
  routing and search quality unchanged.

Coming from 2.x: [Moving from 2.x to 3.0](docs/MIGRATION.md). Every change: [CHANGELOG](CHANGELOG.md).

## The problem

A coding agent is capable and forgetful. Every session it:

- **starts from zero** — it has no memory of your architecture, your conventions,
  or the decision you made last week, so you re-explain the project each time;
- **guesses its approach**, because nothing routes it from "add authentication"
  to the knowledge that applies to authentication;
- **works without a shape** — no explicit start, no checkpoints, no way back when
  a turn goes wrong;
- **and then tells you it is finished.** *"Should work."* *"Pre-existing issue."*
  *"Skipping tests for now."*

The last one is the expensive one. A finished task and a confident sentence look
identical, and you find out which you got later.

## What happens after you install it

One task, start to finish. This is the whole product:

```mermaid
flowchart LR
    A["You: add authentication<br/>to the API"] --> B["begin_task<br/><i>loads project context:<br/>stack, conventions,<br/>past decisions</i>"]
    B --> C["routes 3 skills<br/><i>out of 614</i>"]
    C --> D["agent writes<br/>the code"]
    D --> E["checkpoint_task<br/><i>+ snapshot of<br/>the working tree</i>"]
    E --> F["verify_task<br/><i>tests, quality gate,<br/>security scan</i>"]
    F -->|fails| D
    F -->|passes| G["complete_task<br/><i>refuses a report<br/>the checks do not back</i>"]
    E -.->|a turn went wrong| H["rollback_task"]
    H -.-> D
```

Four things the agent could not do before:

| | |
| --- | --- |
| 🧠 **It remembers the project** | `begin_task` compiles a context pack: the stack, the conventions, the architectural decisions on record, the handoff from the last session, and the instincts learned across sessions. You stop re-explaining. |
| 🎯 **It finds the knowledge that applies** | Hybrid search (keyword + sparse + optional local BGE-M3) routes the request to at most three skills out of 614 — enough to be useful, few enough to stay in context. |
| 🔒 **It works inside a lifecycle** | Begin, checkpoint, verify, complete. Every checkpoint snapshots the working tree, so any turn can be undone without touching your branch, stash or index. |
| ✅ **It cannot just say it is done** | `complete_task` lints the completion report against the checks that actually ran. "Should work", "pre-existing issue", "skipping tests for now" come back refused, with the rule and what is missing. |

**→ [Watch it run on a real task](docs/DEMO.md)** — "add authentication to the API",
scene by scene, including the verification failure and the fix.

## Install

Three ways, one system — pick by what you have:

| | |
| --- | --- |
| **The desktop app** — Windows, Linux, no terminal | Download the package for your system from the [releases](https://github.com/stonebridgeway/ai-dev-system/releases): `AI-Dev-Setup-<version>.exe`, or the AppImage / `.deb`. No Node, Python or Docker: the app brings its own Node. |
| **A server for AI agents, from the terminal** — Linux, Windows | `npx ai-dev-system setup` — Node.js 22.16+ (or 24+), and nothing else. |
| **Docker** — the server in a container | `sh ./bootstrap.sh` on Linux, `bootstrap.ps1` on Windows, with Docker running; on Windows also Node.js 22.12+ and a clone of the repository, since Node writes the clients' configs. For a machine that should not hold a personal vault, or a team that wants one image everybody runs the same way. |

**macOS is in development.** Its code is in the repository and CI runs its tests on a Mac, but 3.0
has no Mac app in its release, and the terminal and Docker installs on a Mac are not supported yet.

### The desktop app

Run the installer on Windows (for your account, no administrator), or the AppImage or `.deb` on
Linux. The first start sets up the runtime and opens a wizard: the folder your projects live in, the
AI clients to connect, the local model and the search index. Restart the clients it connected, and
that is the install. The Windows app and the AppImage update themselves from the releases.

![The first-run wizard: the projects folder, the AI clients, the local model, the index](docs/images/app-wizard.png)

After that its screens change everything: the install's health, your projects with their tasks and
decisions, the skills — your own too, from a folder, a template or a GitHub repository — a
repository's guard rules, hooks and engineering rules, the MCP servers your clients start, and the
settings. More in [Desktop app](docs/DESKTOP.md).

### From the terminal

```bash
npx ai-dev-system setup
```

`setup` installs its own copy into `~/.ai-dev`, asks whether to connect the AI clients it
finds — Claude Code, Claude Desktop, Cursor, VS Code, Codex and Gemini CLI — and whether to
fetch the local search model (`--yes` takes the defaults: clients yes, model no), builds the
search index, and connects the clients. Each client gets one entry, `ai-dev`, that starts your
Node by its full path, so a client opened from the Start menu or a desktop launcher finds it too.
Every other server in those files stays as it was, each file is backed up before it changes, an
`ai-dev-system` entry from 2.x is replaced, and running it again changes nothing. Restart the
clients afterwards; that is the whole install.

Then `ai-dev` alone opens a menu over every setting — each choice prints the command it runs, so
the same thing can go into a script — and `ai-dev settings`, `skills`, `rules`, `servers` and
`status` do it directly, over SSH too
([Configuring a server from the terminal](docs/INSTALL.md#configuring-a-server-from-the-terminal)).

![The ai-dev menu in a terminal, and the MCP servers of a repository with what to check in them](docs/images/terminal-servers.png)

Search, hybrid ranking, the knowledge galaxy and project preparation all run in Node. Python is
optional: two tools — `query_ui_ux_knowledge` and `generate_ui_ux_design_system`, over the UI
UX Pro Max dataset — run a Python script, and without Python they say so. The local dense model
is one flag, `setup --model`: a pinned, checksum-verified ONNX export of BGE-M3, run in Node; a
broken download continues where it stopped, and `AI_DEV_MODEL_MIRROR` and `HTTPS_PROXY` are
honoured.

### Docker

`bootstrap.sh` (`bootstrap.ps1` on Windows) checks that Docker answers, pulls the image, checks that
the server in it answers the MCP handshake, and writes into each AI client it finds an entry that
starts `docker run -i --rm …` itself: each session is its own container, with nothing running
between sessions. Your data lives in the volume `ai-dev-system-data`, and the server sees only the
projects folder bootstrap mounts. One `docker run … ai-dev model install` puts the local model into
the volume. Details: [Docker](docs/INSTALL.md#docker).

Every client's configuration block, the local model, updating from 2.x, uninstalling, and what to
do when it does not work: **[docs/INSTALL.md](docs/INSTALL.md)**. Working on AI Dev itself, from a
clone: [CONTRIBUTING.md](CONTRIBUTING.md).

## Your first task

Open a repository in your client and say:

```text
Use the ai-dev MCP server. Begin a task for ~/Dev/my-project:
add CSV export for the report, cover the change with tests, and run verify_task.
```

With Docker the server sees only the projects folder bootstrap mounted — `AI-Dev-Projects` in your
home, unless `--project-path` (`-ProjectPath` on Windows) or the entries bootstrap replaced named another —
so keep the project there.
On Linux the server sees it at its own path; on Windows it sees the folder as
`/workspace`: name the project `/workspace/my-project`.

What you should see: the agent calls `begin_task`, reports the context it
compiled and the skills it routed, writes the code, checkpoints, runs
`verify_task`, and only then closes the task — with a pull request description
written from the evidence into `.ai-dev/pr/<task_id>.md`. In a repository AI Dev
has not seen before, it first runs `prepare_project`, which writes `AGENTS.md`
and the checks `verify_task` runs, `.ai-dev/quality-gate.md`, from the
project's own scripts.

If it tries to close early, it will not be allowed to. That is the point.

## A look around

| | |
| --- | --- |
| ![Status: the model, the index, the AI clients and every health check](docs/images/app-status.png) | ![Skills: your own beside the catalogue, search, and the groups](docs/images/app-skills.png) |
| **Status** — the model, the search index, the connected clients and every health check, with what to do about each one that is not passing. | **Skills** — the 614 that ship with AI Dev by group, search across them, and your own skills: add a folder, start one from a template, or import a GitHub repository of skills. |
| ![Rules: a repository's guard rules, agent hooks, engineering rules and MCP servers](docs/images/app-rules.png) | ![Settings: profiles, the model folder and mirror, the daemon](docs/images/app-settings.png) |
| **Rules** — a repository's guard rules (what the agent hooks block or warn about), the hooks themselves, the engineering rules written for every client, and the MCP servers the clients start there. | **Settings** — the tool profiles, the projects and model folders, the mirror, the daemon's idle time and the language — each one also `ai-dev settings set …` in a terminal. |

![The knowledge galaxy: every note and skill as a star beside its nearest neighbours in meaning](docs/images/galaxy.png)

The **[knowledge galaxy](docs/GALAXY.md)** — the vault as a 3D galaxy to fly through, in place of
Obsidian's graph view: similar notes form constellations whether or not anyone linked them.

## What you get

The server exposes 135 tools to an agent (and 16 more, the [control API](ai-dev-mcp-server/docs/CONTROL-API.md), to an app that asks for them). You do not need to know them — they are grouped
into eight **capability profiles**, and only `core` is on the critical path:

| Profile | Tools | What it adds |
| --- | --- | --- |
| **`core`** | 25 | Project context, skill routing, and a task from first command to verified completion. *Always on.* |
| `coding` | 18 | Epics, the plan gate, project cards, and the repository's own engineering rules. |
| `memory` | 17 | Decisions, session handoffs, instincts learned across sessions, and a 3D galaxy of the vault to fly through. |
| `git` | 9 | Isolated worktrees, snapshots and rollback, diff review, pull request text. |
| `frontend` | 13 | Brief, visual directions, design system, references. |
| `qa` | 8 | Playwright and visual QA, and the benchmarks that hold search and routing honest. |
| `security` | 9 | Secret and dependency scans, dependency fix plans, command and write policy, MCP inventory. |
| `advanced` | 36 | Diagrams, the search and skill indexes, the dashboard, usage, packaging. |

Set `AI_DEV_PROFILES=core,git` and the server advertises 34 tools instead of 135
— about 34 KB of `tools/list` schema for the client instead of 141 KB, before
the model has read a word of your request (measured; the command is in
[Capabilities](docs/CAPABILITIES.md#what-narrowing-actually-costs-and-saves)). Unset, everything is on and nothing is hidden —
unless profiles were chosen in the settings (`profiles` in `~/.ai-dev/config.json`, which the
desktop app writes): they fill an unset `AI_DEV_PROFILES` for every `ai-dev` command.

**[docs/CAPABILITIES.md](docs/CAPABILITIES.md)** — what each profile carries and
when to turn it on.

## How it works

```mermaid
flowchart TB
    subgraph client["Your MCP clients (Claude Code, Cursor, VS Code, Codex, Gemini)"]
        agent["the agent"]
    end
    agent <-->|stdio, no network port| entry["ai-dev entry<br/><i>one per client</i>"]
    entry <--> daemon["ai-dev daemon<br/><i>one for every client:<br/>135 tools in 8 profiles</i>"]
    app["Desktop app / ai-dev CLI"] -.->|control API| daemon
    daemon --> ctx["Project context<br/><i>stack, conventions,<br/>decisions, handoffs</i>"]
    daemon --> skills["Skill library<br/><i>614 skills,<br/>hybrid search</i>"]
    daemon --> life["Task lifecycle<br/><i>snapshots, quality gate,<br/>completion linter</i>"]
    ctx & skills & life --> disk[("Your machine only<br/><i>~/.ai-dev + .ai-dev/ in the repo</i>")]
```

Everything is local and readable: project state lives in `.ai-dev/` inside the
repository (reviewable in a pull request), personal memory in `~/.ai-dev/`. The
Docker image carries no vault, tokens, projects, or task history, and the
container runs with no network, no capabilities, and a read-only root filesystem.

## Documentation

| | |
| --- | --- |
| [**Demo**](docs/DEMO.md) | One real task end to end, including the failure and the fix. |
| [**Install**](docs/INSTALL.md) | The three ways to install, every client, the local model, uninstalling, diagnostics. |
| [**Moving from 2.x**](docs/MIGRATION.md) | What 3.0 changes for a 2.x install, what moves by itself, and the way back. |
| [**Desktop app**](docs/DESKTOP.md) | The tray, the first-run wizard and every screen. |
| [**Workflow**](docs/WORKFLOW.md) | The task lifecycle, epics, undoing a turn, memory and learning. |
| [**Capabilities**](docs/CAPABILITIES.md) | The eight profiles and how to narrow the tool surface. |
| [**Knowledge Galaxy**](docs/GALAXY.md) | The vault as a 3D galaxy to fly through, in place of Obsidian's graph view. |
| [**Guard rails**](docs/GUARDRAILS.md) | Agent hooks, policy rules, MCP inventory, local data and security. |
| [**Tool reference**](ai-dev-mcp-server/docs/TOOLS.md) | All 151 tools — the 135 an agent sees and the 16 of the control API — generated from the server itself. |
| [**Control API**](ai-dev-mcp-server/docs/CONTROL-API.md) | The tools an app drives the install with, and the answers they promise. |
| [**Architecture**](ai-dev-mcp-server/docs/ARCHITECTURE.md) | How the server is put together. |
| [**Changelog**](CHANGELOG.md) | What changed, and what to re-check after upgrading. |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, how the test
suite is split between a standalone checkout and a full vault, and the checks CI
runs.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
Security reports: [SECURITY.md](SECURITY.md).

## Licences

AI Dev is © 2026 stonebridgeway, under the [PolyForm Noncommercial License 1.0.0](LICENSE) from 3.0:
free for personal use, study, research, hobby projects and noncommercial organisations, changes
included; any commercial use — at work, in a company's product or service — needs a commercial
licence from the author: [Telegram @stonebridgeway](https://t.me/stonebridgeway). 2.x and earlier
were released under MIT and stay under it.

The bundled skill catalogue is imported work, not written here. Every source is
MIT, ships its licence text beside its own files under
`docker/public-seed/03-skills-catalog/sources/`, and is recorded in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with the revision that was
imported: [Membrane application-skills](https://github.com/membranedev/application-skills)
(460 of its 3,074 connectors — the developer tools and AI models, see
[CURATION.md](docker/public-seed/03-skills-catalog/sources/external/membrane/CURATION.md)), [ECC — Everything Claude Code](THIRD_PARTY_NOTICES.md) (101),
[Understand Anything](https://github.com/Egonex-AI/Understand-Anything) (9),
[mattpocock/skills](https://github.com/mattpocock/skills) (1), and the
[taste-skill](https://github.com/Leonxlnx/taste-skill), [ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) and [Archify](https://github.com/tt-a1i/archify) design and diagram tooling.
