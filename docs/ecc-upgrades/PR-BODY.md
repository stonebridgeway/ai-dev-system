# ECC upgrades: stages 0–3, the debt pass, and a source install that works

## What and why

This is the work from the `BreezeAreaSay` fork: the ideas worth taking from
[ECC](https://github.com/affaan-m/ECC), the server split into modules that can be
tested, and a first run that does not require an Obsidian vault to be useful.
103 commits, 364 files, 924 tests (917 pass, 7 skipped), 133 tools, and the main
module down from 10,452 lines to 4,813 under a ceiling that ratchets.

Every claim below is a measurement, not a report: each change was checked with an
adversarial probe against the running server before it was merged, and what the
probes found is written down in `docs/ecc-upgrades/DEBTS.md` — 29 entries with the
measurement that produced them, 23 closed, 2 closed in part, 4 open and named.

### Stage 1 — the server became testable

`src/mcp-stdio.mjs` was 10,452 lines. It is 4,813 now, with the rest in
`src/core/*` (pure logic, each with its own test) and `src/extensions/*` (MCP
tools behind a `createXxxTools(host)` factory and a registry). A static gate
holds the ceiling at 5,076 lines and caps any module at 800, so the file cannot
grow back.

### Stages 2–3 — what came from ECC

Decision ledger, usage ledger with a rate table, change hygiene, per-task
worktrees, a rules library with fourteen packs, a planning gate, session memory,
instincts and their proposals, agent hooks with a policy file, fact forcing, git
hooks through `core.hooksPath`, pull-request preparation from task evidence, a
completion-statement linter, task snapshots and rollback, security scanners,
policy rules with an MCP inventory, coverage gaps, epics, an import graph in the
project map, and a distillation of a repository's own conventions into a draft
rules file. 101 skills imported from ECC's catalogue reach routing through a
reserved slot and a bilingual concept table.

### The debt pass

Nine defects the probes found, fixed in one pass with before/after measurements.
The one that changed a verdict: the security scanner matched the bare word
`proxy` against a scanner's whole output, so an npm advisory titled "…cache-key
and proxy interpretation differentials" turned a finished audit into "could not
reach the network" — this repository's fourteen findings, five of them high, came
back as `skipped`, and `verify_task` passed its security check because a skipped
scanner cannot block. Offline is decided by the failure channel now. The rest are
in the changelog, each with its measurement.

### A source install that works

A clone with no vault could not find its own helper trees (`search-index/`,
`embeddings/`, `frontend-qa/`, `search-eval/` live in the repository root; the
runtime only ever looked for them under a vault's `09-mcp/`). `clients:install`
— the one command a new user is told to run — computed the server's path the
same way and refused to install anything. Hybrid search died without the
BGE-M3 model it documents as optional. `prepare_project` wrote project names and
absolute paths into the repository's own seed. Three tools crashed instead of
stating their contract, nine refused calls that filled every required field, and
the health check demanded notes a checkout cannot have.

All of that is fixed, and `npm run setup` builds what a clone does not ship —
skill registry, search index, routing benchmark — with `--frontend-qa` and
`--dense` for the two steps that reach the network. Measured on a bare clone:
133 tools, none broken; 93 answer with plausible arguments; the health check's
failures go from six to one, and the one that remains is the 2.3 GB model
download, which is a decision a person makes.

## Type

- [x] Bug fix
- [x] Feature
- [x] Refactor / internal
- [x] Docs
- [x] Build / CI / packaging

## Checklist

- [x] `npm run check` passes from `ai-dev-mcp-server/` — with one caveat, measured
      and recorded as Д-11: roughly two runs in ten exit non-zero with
      `Warning: Could not report code coverage. SyntaxError: Unexpected end of
      JSON input` and `# fail 0`. No test fails in those runs. The same rate was
      measured on the base commit in its own worktree, so it is the suite's
      behaviour under load rather than anything in this diff.
- [x] New behaviour has tests; `src/core/` additions have JSDoc types
- [x] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] Conventional commit messages (`type(scope): subject`) — the earlier commits
      follow it; the later ones use a plain sentence subject with the reasoning
      in the body. Say the word and they can be rewritten before merge.
- [x] No secrets, tokens, personal paths, or a personal vault in the diff
- [x] Docs updated if behaviour, flags, or setup changed

## What is not verified

The local BGE-M3 model was never run end to end: the sandbox this was built in
denies `huggingface.co` and `download.pytorch.org`, so the weights could not be
downloaded. Everything up to that point is verified — the interpreter is found,
the worker starts, and the failure now names the missing model directory instead
of an exit code. `npm run setup -- --dense` on a machine with network access is
the remaining check.

Two things need an account-level fix rather than a code one: GitHub Actions has
never run in the fork (19 runs, every job fails in two seconds with no runner and
logs that 404 — recorded as Д-5), and `bootstrap.sh` installs the published image
from GHCR, which is only rebuilt when that workflow runs.

---
_Generated by [Claude Code](https://claude.ai/code)_
