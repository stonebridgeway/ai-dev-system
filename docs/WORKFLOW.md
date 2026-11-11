# Workflow

[← README](../README.md) · [Install](INSTALL.md) · [Capabilities](CAPABILITIES.md) · [Guard rails](GUARDRAILS.md)

How a task actually runs, what to do when it is too big for one arc, how to undo
a turn, and what the system remembers between sessions. For a single worked
example from first command to closed task, see the [demo](DEMO.md).

## Working with the agent

1. Open the target repository in your MCP client.
2. Give the agent a concrete task and the project's path (in Docker on Windows, under
   `/workspace`).
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

**What the four tools answer.** `begin_task` (and `begin_task_in_worktree`, which starts the task in
a worktree of its own) returns the task, its acceptance criteria, the compiled context and the
routed skills; `checkpoint_task`, `verify_task` and `complete_task`
return what changed — the checkpoint and its snapshot, each check with its status and, for a
check that did not pass, the part of the output that says why, the closed task and its pull
request — and not the whole task record again. On the task in [the demo](DEMO.md) that is 33 KB of
answers instead of 242 KB. `get_task` returns the whole record, `include_details: true` on any of
the four returns it in place of the summary, and `AI_DEV_RESPONSE_MODE=full` in a client's
environment makes every answer the whole record, for a client that reads it.

Example request to the agent:

```text
Use the ai-dev MCP server. Begin a task for ~/Dev/my-project:
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
