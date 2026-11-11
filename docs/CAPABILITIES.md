# Capability profiles

[← README](../README.md) · [Install](INSTALL.md) · [Workflow](WORKFLOW.md) · [Guard rails](GUARDRAILS.md)

The server exposes 135 tools to an agent. That is a strength when the agent needs one of them
and a cost the rest of the time: every tool in `tools/list` is schema text the
model carries before it has read a word of your request.

Capability profiles cut that surface along the lines you already think in.

## The eight profiles

| Profile | Tools | What it adds | Turn it on when |
| --- | --- | --- | --- |
| **`core`** | 25 | Project context, skill routing, and a task from first command to verified completion. | Always on. It cannot be switched off. |
| `coding` | 18 | Epics, the plan gate, project cards and auto-commands, the repository's own engineering rules. | Work that spans several tasks, or a repository whose rules the agent should install and follow. |
| `memory` | 17 | Decisions, session handoffs, instincts, the knowledge notes behind them, and the Knowledge Galaxy to fly through them. | You want the next session to start where this one stopped. |
| `git` | 9 | Isolated worktrees, snapshots and rollback, change-hygiene review, pull request text. | The agent touches a real working tree you care about. |
| `frontend` | 13 | Brief, visual directions, concept jury, design system, reference factory. | Building or reviewing a user-facing surface. |
| `qa` | 8 | Playwright and visual QA runners, and the benchmarks that hold search and routing honest. | Verification has to produce evidence a person can look at. |
| `security` | 9 | Secret and dependency scans, dependency fix plans, command and write policy, agent hooks, MCP inventory. | Setting up guard rails, or auditing what your agents are wired to. |
| `advanced` | 36 | Archify diagrams, the search and skill indexes, the dashboard, usage ledger, runtime packaging. | Maintaining the system itself rather than using it. |

A ninth profile, `control`, is left out of this table because an agent never
needs it: its 16 tools — the install's status, setup, the local model, the AI
clients connected, logs, settings, the person's own skills and an overview of
the work — are what a desktop app drives, and three of them delete things
(`model_remove`, `clients_remove` and `custom_skills_remove`, each behind
`confirm`). An empty `AI_DEV_PROFILES` and `all`
leave it out; a session lists it only when it names it — `AI_DEV_PROFILES=control`,
or `all,control` for everything. Its answers are a versioned contract:
[CONTROL-API.md](../ai-dev-mcp-server/docs/CONTROL-API.md).

Every profile runs on Node alone, with one exception in `frontend`:
`query_ui_ux_knowledge` and `generate_ui_ux_design_system` read the UI UX Pro Max
dataset through its own Python script, so they need Python 3 on `PATH` (or
`AI_DEV_PYTHON`). Without it they answer with what to install, and
`npm run doctor` marks `ui_ux_knowledge` skipped.

The authoritative per-tool mapping is the `Profile` column in the
[tool reference](../ai-dev-mcp-server/docs/TOOLS.md), which is generated from the
server's own definitions. Every tool belongs to exactly one profile, and CI
refuses a new tool that belongs to none.

## Turning them on

Set `AI_DEV_PROFILES` in the server's environment — in your MCP client's `env`
block, or in the shell that launches it:

```bash
AI_DEV_PROFILES=core,git        # 34 tools
AI_DEV_PROFILES="coding memory" # commas or spaces, both work
AI_DEV_PROFILES=all             # every profile, whatever the settings say
```

`core` is added to whatever you name, so `AI_DEV_PROFILES=git` and
`AI_DEV_PROFILES=core,git` mean the same thing.

**Unset, every profile is on** — unless you chose profiles in the settings: a
`profiles` value in `~/.ai-dev/config.json`, which the desktop app and the
`settings_set` tool write, fills an unset or empty `AI_DEV_PROFILES` for every
`ai-dev` command, and so for every client a local install connected. Nothing is
hidden until you ask for it, so an installation that never heard of profiles
behaves exactly as it did before they existed.

In a client configuration it goes into the entry's `env` block, beside any
variable the entry already carries (`AI_DEV_VAULT_ROOT`, `AI_DEV_HOME`):

```json
{
  "mcpServers": {
    "ai-dev": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/ai-dev-mcp-server/bin/ai-dev.mjs", "mcp"],
      "env": {
        "AI_DEV_PROFILES": "core,git,memory"
      }
    }
  }
}
```

A Docker entry runs the server in a container, which its `env` block does not
reach: there the variable goes among the `docker run` arguments,
`"--env", "AI_DEV_PROFILES=core,git,memory"`, before the image.

## What narrowing actually costs and saves

Measured as what a client actually receives: the `tools` array of the
`tools/list` result, serialized, in bytes (1 KB = 1,000 bytes):

| Setting | Tools listed | `tools/list` schema |
| --- | --- | --- |
| `core` | 25 | 23,574 bytes (~24 KB) |
| `core,git` | 34 | 33,600 bytes (~34 KB) |
| `core,coding,git,memory` | 69 | 70,428 bytes (~70 KB) |
| unset / `all` | 135 | 140,645 bytes (~141 KB) |

To measure it yourself (macOS / Linux shell; change `AI_DEV_PROFILES` per row,
empty for all):

```bash
cd ai-dev-mcp-server
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"size","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | AI_DEV_PROFILES=core,git node src/server.mjs \
  | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{for(const l of s.split("\n"))if(l.includes("\"id\":2")){const t=JSON.parse(l).result.tools;console.log(t.length+" tools, "+Buffer.byteLength(JSON.stringify(t))+" bytes")}})'
```

The numbers are for the server as of this release; a tool added or reworded
changes them, which is why the command is here. How a client then packs the
schema into the model's context is up to the client.

Two things it does **not** do:

- **It does not disable anything.** Narrowing affects `tools/list` only.
  `tools/call` still accepts every tool by name, so a client that already knows
  a name keeps working, and nothing in the system becomes unreachable.
- **It is not a security boundary.** It is a context-budget control. The things
  that actually refuse an action are the [guard rails](GUARDRAILS.md).

A narrowed server says so on stderr at startup, naming the profiles and the tool
count, so "the tool is missing" is never an unexplainable symptom:

```text
ai-dev: capability profiles core, git — 34 of 135 tools listed. Unset AI_DEV_PROFILES for all of them.
```

A profile name it does not recognise is reported and ignored rather than taken as
an empty list — a typo should not quietly cost a session half its tools.

## Choosing a set

- **Backend or API work:** `core,git` — and add `coding` once the work spans more
  than one task.
- **A long-running project you return to:** `core,git,memory`.
- **Frontend work:** `core,git,frontend,qa`.
- **Setting the repository up for a team:** `core,coding,security`.
- **Working on AI Dev System itself:** leave it unset.

If you are not sure, leave it unset. The profiles are there for when the tool
surface starts costing you something, not as a step you have to complete first.
