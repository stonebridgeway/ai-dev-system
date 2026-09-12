# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`npm run setup`**: the first run, as one command. A clone ships the server,
  the skills and the seed, but four things are built rather than shipped — the
  skill registry, the SQLite search index, the skill-routing benchmark report
  and the Frontend QA runner's dependencies — and until they exist the health
  check fails and the search tools answer with refusals. `npm run setup` builds
  the three that need nothing but the repository; `--frontend-qa` installs the
  QA dependencies; `--dense` builds the Python environment and downloads the
  2.3 GB BGE-M3 weights, because a download that size is a decision a person
  makes rather than something a setup command does behind their back. Every step
  is idempotent, says whether it ran and why, and the run ends with the
  diagnostic, so what is still missing is on the screen rather than in a
  document (`src/core/first-run.mjs`, `scripts/first-run.mjs`). Measured on this
  repository: routing benchmark 37/37, search index 332 documents, and the
  health check's failures drop from three to one — the model weights.

- **Distilled project rules** (`distill_project_rules`): reads what a repository
  already does — module system, Node built-in import style, Python import style,
  source and test file naming, where tests live, which test runner, how failures
  are raised, whether caught errors are acted on — and writes it to
  `.ai-dev/rules/project.md` with `status: draft`. Every statement carries the
  counts it came from, and a convention the repository splits on is reported as
  split instead of being turned into a rule. It complements
  `install_project_rules` rather than replacing it, and never writes over an
  existing file: the answer distinguishes a draft (safe to regenerate) from one
  whose `status: draft` line a person has removed (`src/core/rules-distill.mjs`).

- **Import graph in the project map**: `.ai-dev/project-map.md` gained an
  "Import graph" section — the modules most of the codebase depends on, every
  import cycle, and the files nothing in the project imports. Read from
  JavaScript/TypeScript and Python sources, resolving only to files inside the
  repository, so a bare specifier is counted as an external dependency and never
  becomes a node. The scan is lazy: the source files are fingerprinted by path,
  size and mtime (a directory walk) and re-parsed only when that moves, so
  `prepare_project`, `refresh_project_map` and `refresh_project_context`
  re-render the map every time and re-read the tree only when it changed
  (`src/core/import-graph.mjs`).

- **Agent harness grading** (`scan_agent_config`): grades a repository's agent
  configuration from A to F over five places nothing else reads together —
  `CLAUDE.md` / `AGENTS.md` that run a command on load or tell the agent in
  prose to stop asking, `.claude/settings.json` that pre-approves `Bash(*)` or
  sets `defaultMode: bypassPermissions`, hook commands that splice a variable
  into a shell, subagents with no `tools:` limit, and everything
  `list_mcp_servers` already finds (folded in, not re-implemented). Findings use
  the change-hygiene shape `{ rule, severity, file, line, message }`; a
  `block` — a setting that removes a check rather than narrowing one — caps the
  grade at D. The grade is written into the project card's new
  "Agent Configuration" section, and credentials are masked with the same
  function the MCP inventory uses (`src/core/agent-config-scan.mjs`).

- **Worktree lifecycle states** (`list_task_worktrees`, `plan_worktree_cleanup`):
  each task worktree is reported as `orphan` (git still registers a directory
  that is gone), `dirty` (uncommitted work lives only there), `merged` (every
  commit is already in the main checkout), `stale` (unmerged commits, nothing
  recent) or `active`, decided worst case first so the state says whether
  removing it costs anything. `plan_worktree_cleanup` offers the merged and
  orphaned ones, offers stale ones only with `include_stale`, never offers dirty
  ones, and removes nothing until `dry_run: false`.

- **State housekeeping** (`prune_state`): retires instincts whose confidence
  fell under 0.3 and that have not been observed for 90 days, archives session
  handoffs and hook observation logs older than 90 days into an `archive/`
  directory beside them (moved, never deleted, and a scope's newest handoff is
  always kept), rotates the usage ledger down to its newest 20 000 events, and
  deletes the snapshot refs of completed *and abandoned* tasks — a task that is
  not complete and has not been updated for 30 days previously kept
  `refs/ai-dev/snapshots/<task>/*` for good, and each live ref pins a whole tree.
  Runs as a dry run unless `dry_run: false`, and reports each of the four areas
  separately so one that fails does not stop the others
  (`src/core/state-pruning.mjs`).

- **Security scanners** (`run_security_scan`): adapters for `npm audit`,
  `pip-audit`, `cargo audit`, `gitleaks`, `semgrep` and `trivy fs`. Each one
  knows how to find its binary, whether this project is one it has anything to
  say about, and how to read its output; every finding comes back as
  `{ tool, kind, severity, file, line, message, rule }`. `verify_task` runs the
  same scan as its `security_scan` check, next to `change_hygiene`: critical and
  high dependency or secret findings fail verification, everything else is
  reported. A scanner that is absent, inapplicable or needs a network this run
  does not have is `skipped` with the reason, so it can neither fail nor delay a
  verification (`src/core/security-scan.mjs`,
  `src/core/security-scan-parsers.mjs`).

- Twelve agent-workflow upgrades, ported from ECC (Everything Claude Code) and
  reshaped for this server. New capabilities, all reachable as MCP tools:
  - **Extension registry** (`src/tool-extensions.mjs`): tools now live in
    `src/extensions/*` as `createXxxTools(host)` factories instead of growing
    `mcp-stdio.mjs`, which is capped at 10,500 lines by the static gate.
    Duplicate names and missing handlers fail at startup.
  - **Decision ledger** (`record_decision`, `list_decisions`): ADR-lite records
    under `.ai-dev/decisions`, folded into the compiled context pack.
  - **Usage ledger** (`record_usage`, `usage_report`): per-tool call telemetry
    plus token and cost accounting reported by the client or the runner.
  - **Change hygiene** (`verify_change_hygiene`): diff scanner for secrets,
    focused/skipped tests, `debugger`, conflict markers and weakened linter
    configuration; runs as part of `verify_task`.
  - **Task worktrees** (`begin_task_in_worktree`, `list_task_worktrees`,
    `remove_task_worktree`): one isolated git worktree per task.
  - **Rules library** (`list_rule_packs`, `install_project_rules`): a catalogue
    of engineering rules (common plus stack packs with `paths:` scoping),
    projected into `.claude/rules`, `.cursor/rules/*.mdc` and `AGENTS.md`.
  - **Plan gate** (`plan_task`, `plan_status`): task-complexity classification
    with a plan required before large or risky work starts.
  - **Session memory** (`save_session`, `resume_session`,
    `context_budget_status`): structured handoffs and a context budget.
  - **Instincts** (`record_instinct`, `list_instincts`, `update_instinct`,
    `evolve_instincts`, `export_instincts`, `import_instincts`): learned
    preferences with confidence, decay, promotion to global and evolution into
    skills.
  - **Agent hooks** (`install_agent_hooks`, `agent_hooks_status`): an
    installable hook pack for Claude Code and Cursor — command/file guard,
    session start and end, pre-compact, post-edit formatting and a stop check —
    configured by `.ai-dev/policy.json` profiles.
  - **Five seed skills** plus an updated `ai-dev-orchestrator`:
    `verification-loop`, `silent-failure-hunter`, `planner`,
    `security-reviewer` and `memory-curator`.

- Archify diagram capability: nine typed MCP tools for local validation,
  rendering, delivery receipts, browser checks, comparisons, migrations, and
  brand references; the clean Docker seed now carries its pinned runtime for
  offline operation. Diagram-request detection (routing, recommendations, and
  acceptance criteria) is a single shared pattern that excludes database and
  API schema work. Delivery-receipt verification enforces the full showcase bar
  (profile, zero errors/warnings, all checks, artifact hash) before an
  acceptance criterion is marked met.
- `docs/ARCHIFY.md`, integration notes, and third-party notices for the
  vendored Archify package and its runtime dependencies.
- `.github/` issue and pull-request templates and a `dependabot.yml` for npm,
  pip, and GitHub Actions updates.
- Stable Homebrew tap formula source for `v1.0.0`, validation of AUR `.SRCINFO`,
  and documented maintainer-only publication paths for `stonebridgeway/tap` and
  `ai-dev-system-git`.
- Windows CI job (`windows-latest`): parses every PowerShell script, runs
  `bootstrap.ps1 -Plan`, exercises the client installer's win32 path handling,
  and runs the core unit suite. The Windows install path had no CI coverage
  before.
- **Selective skill import** (`import_skill_repo` with `select_skills: true`,
  `src/core/skill-import-policy.mjs`): imports only the `skills/<name>`
  directories of an upstream catalogue that pass four gates — taxonomy
  exclusions with a cited reason, a name already owned by a local skill (ours
  wins), the public-seed privacy audit, and a minimum quality score
  (`min_quality_score`, default 75). `dry_run: true` reports the plan without
  writing. The result and the generated `upstream.json` record how many skills
  were imported and why each of the rest was left out.
- **ECC skill catalogue** as `external/ecc` (`docs/ecc-upgrades/PLAN.md`, item
  3.1): 101 of ECC's 291 skills (MIT, pinned to a commit), among them
  `tdd-workflow`, `api-design`, `contract-first`, `hexagonal-architecture`,
  `intent-driven-development`, `database-migrations`, `error-handling`,
  `production-audit` and the language `*-patterns` / `*-testing` families. They
  carry `trust_level: known-upstream` and `instruction_policy:
  data-until-review`, declared in `upstream.json` and reported by
  `recommend_skills`: their text is reference material until someone reviews it,
  not instructions to follow on sight. 190 skills were left out — 168 by
  taxonomy rule, 17 below the quality floor, 4 for a privacy-audit finding, and
  ECC's `verification-loop`, whose name our custom skill already owns.
- Cost capture and a model rate table, so a session's spend is visible without
  the client reporting anything:
  - **`cost-capture.mjs`**, an eighth hook, registered on `Stop` at every
    profile. It sums the `usage` of the assistant messages a transcript gained
    since the last run — subagent turns included, since they are billed the
    same — and appends one `kind: "usage"` event per model to the usage ledger,
    writing the file directly so it works while the server runs in Docker. A
    byte cursor per session (`state/usage/sessions/<session>.json`) keeps the
    same message from being billed twice however often `Stop` fires, and a
    transcript that shrank is read from the top again.
  - **`RATE_TABLE`** in `core/usage-ledger.mjs`: published USD per million
    tokens per model, read from Anthropic's pricing page on the date recorded
    in `RATE_TABLE_SOURCE`, with the cache multipliers (5-minute write 1.25x,
    1-hour write 2x, read 0.1x) filling the rows that do not state their own.
    Prices change, so `model_rates` in `.ai-dev/policy.json` overrides or adds
    any row per project.
  - **`usage_report`** now returns the `today` / `yesterday` / `last_7_days`
    slices alongside the per-model and per-task totals, and estimates cost from
    the rate table wherever the client reported none — a reported cost still
    wins, and a model the table does not know is listed under
    `rates.unpriced_models` instead of counted as free. Pricing happens at read
    time, so a price change re-prices history rather than freezing a stale
    number into the ledger.
- **`prepare_pull_request`**, a new tool in `src/extensions/pull-requests.mjs`,
  writes the pull request description a task has already earned. It reads the
  task record — goal, acceptance criteria with their status and evidence,
  checkpoints, the latest `verify_task` run and the checks it executed,
  recorded decisions, the plan — and the repository diff against the base
  branch, then writes `.ai-dev/pr/<task_id>.md` and returns the text.
  - The repository's own template is filled, not ignored:
    `.github/pull_request_template.md` and the usual variants (including a
    `PULL_REQUEST_TEMPLATE/` directory) are discovered, each heading it
    recognises receives the matching evidence, headings that belong to the
    author — a checklist, a "type of change" list, screenshots — keep their
    text, and generated sections that matched no heading are appended so no
    evidence is dropped.
  - Changed files are listed by group (tests, CI, docs, configuration, assets,
    source) with their status, alongside the commits on top of the base and the
    checks that ran — including the ones that did not.
  - Acceptance criteria that are not met, a failed or missing verification and
    blocking hygiene findings go into an "Outstanding" section, so an unfinished
    change cannot look finished.
  - It pushes nothing and opens nothing: `git push -u` and
    `gh pr create --body-file` come back as text for a human to run.
  - `complete_task` prepares the same file at completion and links it from
    `next_step` (`prepare_pull_request: false` opts out).
- **Completion-statement linter** (`src/core/completion-claims.mjs`): the
  `summary` and `notes` of `checkpoint_task` and `complete_task` are now held to
  the evidence behind them. Twelve rationalizations — "pre-existing issue",
  "skipping tests for now", "tests are failing but I'll fix them later", "works
  on my machine", "should work", "untested", "flaky", "disabled the lint rule",
  an untracked TODO, "good enough for now", "didn't check the UI", "verified
  manually" — each name the gate that would settle them (`quality_gate`,
  `change_hygiene`, `frontend_qa`, or the latest `verify_task` run).
  - A rationalization over a gate that did not pass, or never ran, is refused
    before anything is recorded; the error names the rule, the gate, the quoted
    phrase and the ways out. Over a passing gate the same wording is only a
    warning, returned in the new `completion_claims` field of both tools.
  - The rule table is data, and `.ai-dev/policy.json` is the knob:
    `completion_claims.enabled: false` turns the linter off, and a waiver
    (`{ rule, reason, expires? }`, `"*"` for all rules) turns off one rule where
    the reason is real — it applies only when the report states that reason too.
    An unknown rule, a reason under 20 characters, an unreadable date or invalid
    JSON leaves the linter on and says so in `completion_claims.warnings`.
  - New seed skill **`self-evaluation`** (quality score 100): five axes scored
    with quoted evidence, a "claim → what backs it" table for eleven sentences
    reports actually contain, and a post-action for each average band.
    `ai-dev-orchestrator` and `verification-loop` route to it before
    `complete_task`.
- **Epics** (`decompose_task`, `epic_status`, `src/core/task-epics.mjs`): a
  task can be broken into children with an order between them.
  - Each child is opened through `begin_task`, so it routes its own skills,
    compiles its own context pack and carries its own acceptance criteria;
    every other tool works on it unchanged.
  - `depends_on` names siblings by key or by 1-based position. A reference to
    nothing, a child waiting for itself, and a ring of children each waiting
    for the next are refused before anything is created — an order that cannot
    be worked is better rejected than opened. At most 20 children, one level
    deep.
  - `epic_status` reports each child's state (done, in progress, ready,
    blocked, and what it is blocked by), how far the epic has come, and the one
    child to work next; asked about a child, it answers with the parent's epic.
    An epic whose every open child waits for another open one is reported as
    deadlocked rather than as "nothing ready".
  - `complete_task` on a parent is refused while any child is open, or while a
    child's record is missing: an epic closes last, on evidence that still
    exists. The task record gained `parent_id`, `depends_on` and `epic`.
  - GitHub Issues are not part of this. ECC coordinates epics through issues
    and labels; this server tracks tasks itself and works offline.
- **`coverage_gaps`** (`src/core/coverage-reports.mjs`,
  `src/extensions/coverage.mjs`): reads whichever coverage report the project's
  own test run left behind — an lcov tracefile, an Istanbul
  `coverage-final.json`, a Cobertura or `coverage.py` XML, or a
  `go test -coverprofile` — and ranks what is not covered.
  - A file the change set touched outranks one it did not, and an uncovered
    function counts double: an untested line in a file just edited was probably
    just written. Uncovered lines come back folded into ranges (`18-24`) with
    the functions that run in no test.
  - Report paths are normalised against the project root and matched to changed
    files on whole trailing segments, so a Go import path and a repository path
    are recognised as one file. Nothing is executed: a report that no run
    produced comes back as `no_report` with the command that would produce one.
  - `verify_task` gained `coverage_min`: a percentage of lines the report must
    show, checked as a new `coverage` check with the five largest gaps
    attached. It fails when the report is missing — a floor nobody could
    measure is not a floor that was met — and `0`, the default, leaves coverage
    out entirely.
- **`propose_instincts`** (`src/core/instinct-proposals.mjs`): the session-end
  hook now leaves an observation log beside its draft — what the user said,
  what tools ran with what, which calls came back as errors — and this tool
  reads one session's log into candidate instincts.
  - Five patterns, ported from ECC's continuous-learning-v2 observer: a
    correction the user made (only after the agent had done something to
    correct), a rule they stated ("always", "never", "use X instead of Y"), an
    error signature that recurred together with the call that finally cleared
    it, a command run three times, and a pair of commands run back to back
    twice. An error signature generalises paths, numbers and quoted values, so
    one failure on two files is one signature.
  - Candidates are not conclusions. Each quotes what was observed, is stored
    with the new status `proposed`, is capped at 0.5 confidence, never reaches
    a context pack, and becomes an instinct through
    `update_instinct(action: "confirm")`. `list_instincts` gained a `status`
    filter to review them; `dry_run` returns them without storing anything.
  - A second run over the same log proposes nothing new: a candidate that
    matches an instinct the store already holds is reported as skipped rather
    than quietly raising that instinct's confidence.
  - The wording is deliberately the user's own, not a paraphrase. The half of
    the observer that needs a model stays with the agent, which confirms the
    candidates and rewrites them with `record_instinct` where they read badly.
- **`list_sessions`**: the handoffs a repository has, newest first, with the
  unconfirmed hook drafts marked and the sessions whose observation log is
  still on disk flagged for `propose_instincts`. `drafts_only` and
  `substantive_only` narrow it.
- **Eleven more rule packs** (`src/core/rules-catalog.mjs`): `vue`, `angular`,
  `react-native`, `fastapi`, `kotlin`, `swift`, `dart`, `csharp`, `cpp`, `php`
  and `ruby` join the eight the catalogue had, each with its own `paths` globs
  and stack labels.
  - The labels they are chosen by are now detected: `nuxt.config.*` or the
    `nuxt` dependency, `angular.json` or `@angular/core`, `build.gradle.kts`
    (Kotlin, alongside Java/JVM), `Package.swift`, `Gemfile`/`Rakefile`/
    `.ruby-version` and `rails` inside them, `artisan` or `laravel/framework`
    and `symfony/framework-bundle` in `composer.json`, `CMakeLists.txt` and its
    neighbours, and the five conventional root files of a .NET repository.
  - `packsForStack` gained its one subtraction: a React Native project no
    longer gets the `web` pack. It shares a library with the browser, not a
    platform — there is no DOM, no CSS and no Core Web Vitals to budget. A
    universal app that also builds for the browser keeps it.
  - `web` already carried ECC's `performance` and `design-quality` rules, so
    those are not separate packs. `perl`, `arkts` and `fsharp` are not written:
    nothing detects them and nothing here could check them (DEBTS Д-16).
- **Git hooks** (`install_agent_hooks` target `git`, `hooks/git-hooks.mjs`):
  a `pre-commit` and a `pre-push` installed through `core.hooksPath`, so the
  same rules apply to a client with no hook API and to a human at a terminal.
  - `pre-commit` scans the staged diff for what change hygiene calls blocking —
    a secret-bearing path, a secret in an added line, a merge-conflict marker, a
    focused test, a left-behind `debugger` or `breakpoint()` — and refuses the
    commit. `pre-push` reports when the active task has no verification or its
    latest one failed. `git_hooks` in `.ai-dev/policy.json` sets each to
    `block`, `warn` (the pre-push default) or `off`.
  - The hooks read the server's own rules from `.ai-dev/hooks/patterns.json`,
    which now also carries the leftover patterns and the placeholder pattern, so
    `password = "correct-horse-battery"` is a finding and
    `password = "REPLACE_ME"` is not.
  - A `core.hooksPath` someone else set is reported, never taken over, and every
    hook in `.git/hooks` that would stop running is named. `agent_hooks_status`
    answers with `git_hooks`, `core_hooks_path` and `git_hooks_active`, the last
    true only when the stubs exist *and* git points at them.
- **Fact forcing** (`hooks/fact-force.mjs`, `fact_force` in
  `.ai-dev/policy.json`, on by default under the `strict` profile): the first
  edit of a file in a session is refused until the agent has put its grounding
  on the record — a `FACTS <path>` block naming the importers, the API the edit
  changes, the data it touches and the instruction it serves — and the first
  destructive command is refused until a `ROLLBACK:` line says how to get back.
  - The refusal quotes the block to write. PreToolUse runs after the turn
    carrying the tool call is written to the transcript, so the facts and the
    edit travel together: the agent writes them, repeats the edit, and the file
    stays grounded for the rest of the session.
  - Eleven groups of command count as destructive — file removal and moves,
    `sed -i`, git history rewrites, `git push`, dependency changes, migrations,
    database writes, infrastructure, permissions, service control. The
    irreversible ones never reach the gate: the guard's hard rules refuse them
    first, for their own reason.
  - Session state lives in `~/.ai-dev/state/guard/<session>.json`: entries
    expire after `expiry_minutes` (30), at most `max_entries` (500) are kept,
    and after `max_denials` (3) refusals in one session the gate stops refusing
    and only notes what was missing.
  - It judges nothing it cannot see: no transcript (Cursor sends a conversation
    id, not a path), unreadable or unwritable state, or a path matching
    `exempt_globs` all leave the call alone. `AI_DEV_FACT_FORCE` and
    `AI_DEV_FACT_FORCE_EXEMPT` override the policy for one run.
- **Documentation freshness** (`docs_stale` in `verify_change_hygiene`): a
  change set that moves the public interface — a new export, an `inputSchema`,
  a command-line flag, in JavaScript, TypeScript, Python, Go, Rust, Java,
  Kotlin, C#, Swift, PHP or a shell script — without touching a single document
  is now a `warn` finding listing the files that did move.
  - Only declarations count. A line inside an exported function does not widen
    the interface, and a flag passed to someone else's program (`--no-color` to
    `git`) is not a flag the project offers, so neither fires the rule.
  - Tests, vendored trees (`node_modules/`, `vendor/`, `dist/`) and the
    documentation itself are not read for interface signals; data files are
    left out too, since a schema key in JSON is as often a fixture as a
    contract. Any `.md`, `.mdx`, `.rst`, `.adoc`, `.txt` or file under `docs/`
    answers the finding, `README.md` and `CHANGELOG.md` included.
  - `summary` gained `interface_files` and `documentation_files`.
- **Task snapshots and rollback** (`src/core/task-snapshots.mjs`,
  `src/extensions/snapshots.mjs`): `snapshot_task`, `list_task_snapshots` and
  `rollback_task` make an agent's turn undoable. A snapshot records the whole
  working tree of a task — tracked changes, staged or not, plus the files the
  agent created — as one commit object no branch points at, held by a ref under
  `refs/ai-dev/snapshots/<task_id>/<n>`.
  - Nothing is written to the user's branch, stash or index. `.gitignore` and
    `.git/info/exclude` decide what a snapshot carries, so dependencies and
    build output are neither stored nor touched.
  - `rollback_task` restores the snapshot's files and removes the ones that
    appeared since, emptied directories included. It snapshots the state it
    replaces first, so a rollback is itself reversible; the snapshot is named by
    id (`snapshot-3`), number, or commit.
  - `checkpoint_task` snapshots the turn it records (`snapshot: false` opts out;
    a project without git reports a reason instead of failing), and
    `complete_task` deletes the closed task's snapshots, reporting how many in a
    new `snapshots` field. The entries stay on the record, marked, so the turns
    remain readable. Automatic snapshots are capped at 50 per task; ones taken
    by name are kept until the task closes.
- **Guard rules without hand-edited JSON** (`src/core/policy-rules.mjs`):
  `list_policy_rules`, `upsert_policy_rule` and `remove_policy_rule` edit the
  `rules` block of `.ai-dev/policy.json` — the rules the installed guard enforces
  on every command and file write.
  - A rule is checked against what the guard actually does with it: the pattern
    is compiled with the guard's own flags, and one that does not compile, an
    event the guard never evaluates, an unknown `action`, or a quantified group
    holding an unbounded quantifier (which would stall the guard on a long line)
    is refused with the reason.
  - A new rule, or a changed pattern, must fire on an `example` the caller
    provides, and must not fire on an optional `counter_example`. The samples are
    stored on the rule, so `list_policy_rules` re-runs them and reports a rule a
    hand edit disarmed. A second rule matching the same text on the same event is
    refused as a duplicate.
  - Updates are patches (`{ id, enabled: false }` disables a rule), `dry_run`
    checks without writing, and `agent_hooks_status` now lists every rule with
    the guard's reading of it plus the problems in the file.
- **MCP server inventory** (`src/core/mcp-inventory.mjs`,
  `src/extensions/mcp-inventory.mjs`): `list_mcp_servers` reads every config a
  client would load — `.mcp.json`, `.claude/settings.json` and
  `settings.local.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
  `.gemini/settings.json` and `.codex/config.toml` (through the new
  `src/core/toml-lite.mjs`, a reader for the TOML subset those files use).
  - One entry per server: the files that declare it, the transport, the
    environment and editor substitutions with whether each variable is set, and
    whether Claude Code starts it without asking.
  - A credential written out in a config file is a `block` finding, masked out of
    the command line and url the report echoes back. Plain HTTP to a remote
    endpoint, an unpinned `npx -y` package, a shell-wrapped command, an entry no
    client can start, `enableAllProjectMcpServers`, a config that cannot be
    parsed, and one server name defined differently in two files are warnings.
  - `include_user_scope` adds the user's own `~/.claude.json` (including its
    per-project block), `~/.cursor/mcp.json`, `~/.gemini/settings.json` and
    `~/.codex/config.toml`; it is off by default.

### Fixed

- **Hybrid search died without the optional model.** The README says it plainly
  — "Hybrid search works without a model: SQLite FTS, sparse aliases, and
  deterministic intent routing are always on" — and the dense embedding call was
  not guarded, so a missing BGE-M3 threw out of the query and took the whole
  search with it. `hybrid_search`, `preset_search` and `explain_search` were
  dead on a fresh install until someone downloaded 2.3 GB. Dense is now the
  optional half it was documented to be: when it cannot run, the keyword and
  sparse ranking answers, and `preset_search` and `explain_search` say why the
  dense half is missing rather than passing off a lexical ranking as a semantic
  one. The dense smoke still fails when dense does not run, which is its job.

- **A freshly built search index reported itself stale.** Every render of a
  skill card stamps `generated_at`, so `rebuild_index` rewrote all 142 of them
  whatever they said, their mtimes moved, and the index built seconds earlier
  came back "stale: 142 changed". Cards are now compared without their stamp and
  left alone when they say the same thing — which also gives `generated_at` the
  meaning a reader expects: when this card last changed. Everything the vault
  writes generated now goes through `atomicWriteIfChanged`, which the repository
  had and nothing used. Measured: `rebuild_index` after a build leaves the index
  fresh, 0 changed.

- **"Playwright Chromium is not fully ready" never said what was missing.** The
  runner knows which of the three pieces is absent, and when the browser binary
  is simply not where Playwright looks it reported an empty `launch_error`. It
  now names the path, says whether `PLAYWRIGHT_BROWSERS_PATH` points somewhere
  else, and gives the install command; the health check repeats the reason
  instead of "not fully ready".

- **Nine tools refused a call that filled every required field.** A JSON Schema
  cannot say "project_path or task_id", so `record_decision`, `list_decisions`,
  `coverage_gaps`, `record_instinct` (project scope), `save_session` (topic or
  building), `record_usage` (tokens or cost) and the three Archify tools that
  take a spec accepted a schema-complete call and then refused it. The
  alternative is now in each tool's description, where a model reads it, and a
  test holds them to it.

- **The required-notes check demanded a layout a checkout cannot have.** Three
  of the six notes it wants live under `09-mcp/` in a vault and in the
  repository's own root in a clone; one exists only in a vault; and one named a
  file — `03-skills-catalog/Skill Cards.md` — that nothing in the runtime has
  ever written. So a healthy source install was told five notes were missing.
  The check now reads each note through the layout it has, requires what that
  layout can carry, and names the catalogue the runtime really renders.

- **`clients:install` could not find the server it installs.** The one command
  the README gives for wiring the server into Cursor, Gemini, VS Code and Claude
  computed its entrypoint as `<vault>/09-mcp/ai-dev-mcp-server/src/server.mjs`.
  From a plain checkout that resolved to `<home>/09-mcp/…` and the command
  refused to touch anything: "Required local paths are missing". It now
  registers the server it is part of, and writes no `AI_DEV_VAULT_ROOT` when
  there is no vault — the server finds the bundled seed on its own. A vault
  install still gets the vault's own copy.

- **Three tools crashed instead of stating their contract.** Called without
  their argument, `search_knowledge`, `search_skills` and `read_skill` answered
  "Cannot read properties of undefined (reading 'toLowerCase')" where every
  other tool answers "query is required." Measured over the protocol: of 62
  read-only tools, 23 answer with no arguments and 39 refuse with a sentence —
  those three were the only ones that broke, and now there are none.

- **The embedding worker's own reason was thrown away.** A worker that cannot
  start says why once, on stdout, before anything is asked of it — "Model
  directory does not exist: ~/.ai-dev/models/bge-m3" — and then exits. The pool
  kept the message and reported only the exit code, so `embed_texts` and
  `hybrid_search` failed with "BGE-M3 worker exited with code 1." and nothing
  else, which is the least useful thing to tell someone who has just installed
  the model. The reason is now carried into the rejection and into
  `embedding_status.workers[].ready_error`.

- **A source install wrote project cards into the repository.** With no vault of
  its own, the runtime falls back to the bundled `docker/public-seed`, and
  `prepare_project` writes a project card there — with the project's name and
  its absolute path. The other generated seed paths are ignored by Git already;
  `02-knowledge/Projects/` was missed, so a clone went dirty the first time
  anyone prepared a project, and `git add -A` would have committed their
  repository names into this one.

- **A checkout without an Obsidian vault could not find its own helpers.** Four
  trees the server runs rather than reads — the SQLite search helper, the
  search-eval cases, the BGE-M3 embedding scripts and the Frontend QA runner —
  were addressed only as `<vault>/09-mcp/<tree>`. A clone of this repository has
  all four in its root and no `09-mcp` at all, and the vault falls back to the
  bundled `docker/public-seed`, which carries notes and skills but no helpers.
  So a fresh clone reported "Search helper not found:
  …/docker/public-seed/09-mcp/search-index/search_cli.py" — a path that can
  never exist there — and semantic search, both search smokes, the skill-routing
  eval and Frontend QA were unreachable without a vault. Each tree is now
  resolved in its own right: the vault layout first, then the repository's, and
  the vault path is what an error names when neither is there
  (`src/core/runtime-assets.mjs`). Measured on a bare checkout: the search
  helper, the embedding worker, the eval cases and the QA runner are all found,
  `frontend_qa_runner` passes, and `search_index_freshness` moves from "helper
  not found" to "the index is stale by 330 notes", which is the next honest step
  rather than a dead end.

- **A security scan read its own findings as a dead network.** `run_security_scan`
  matched the word `proxy` — along with `offline`, `unable to connect` and
  `failed to fetch` — against a scanner's whole output, so an advisory titled
  "…cache-key and proxy interpretation differentials" turned a finished
  `npm audit` into "could not reach the network". This repository's fourteen
  findings, five of them high, came back as `skipped`, and `verify_task` passed
  its `security_scan` check because a skipped scanner cannot block. Offline is
  now decided by the failure channel: machine tokens only (`ENOTFOUND`,
  `ECONNREFUSED`, `getaddrinfo`, npm's own network banner, and the rest), read
  only when the scanner produced no findings at all — one that reported findings
  reached whatever it needed to reach. The report is read alongside `stderr`
  because `npm audit --json` prints its own network failure as a JSON document
  on stdout and still exits 1. The reason now carries the exit code and the
  first line of `stderr` instead of a slice of somebody's dependency tree
  (`src/core/security-scan.mjs`).

- **One slow policy rule cost one budget; thirty cost thirty.** The guard gave
  every rule its own 250 ms and raised a fresh worker after each overrun, so a
  `.ai-dev/policy.json` with thirty catastrophic patterns held a Bash command
  for 8.7 seconds — past the ten at which the client abandons the hook, which is
  the failure the budget existed to prevent. All of an event's rules now share
  one deadline (`POLICY_MATCH_DEADLINE_MS`, 1 s), the remaining budget also caps
  the next rule, and every answer says whether it ran (`checked`). The guard
  prints one line per rule that blew its own budget and one line for everything
  the deadline cut off; `list_policy_rules` marks such a rule `match_not_checked`
  rather than reporting it as matching nothing. Thirty rules: 8.7 s → 1.1 s; an
  honest policy is unchanged (`src/core/regex-budget.mjs`, `hooks/lib.mjs`,
  `hooks/guard.mjs`).

- **A secret in `env` was the one place `scan_agent_config` did not look.** The
  settings scan read only top-level strings, and `env` — how Claude Code puts
  variables into a session — is where a credential actually goes. The document
  is now walked to the leaves, arrays included, and the finding names the path
  (`env.AWS_ACCESS_KEY_ID`, `hooks.PreToolUse[0].hooks[0].command`) with the
  value masked.

- **The most direct way to turn the permission prompt off was not recognised.**
  "Always use `--dangerously-skip-permissions`" named no pattern at all, and
  "Run `npm run dev` automatically … no need to ask" matched neither half of the
  prose rule. Flag literals are now their own blocking rule
  (`instructions_disable_permission_prompt`), a line that forbids the flag is
  not a finding, and the prose covers "no need to ask", "without prompting",
  "skip the confirmation", an imperative "Run … automatically", and their
  Russian halves. `always run …` is gone from the list: "Always run the tests
  before you claim the task is done" waives nothing, and a rule that calls an
  honest instruction a bypass is a rule people stop reading. Fifteen phrasings
  in two languages: seven caught before, fifteen now, with the one false
  positive gone (`src/core/agent-config-scan.mjs`).

- **A half-written `~/.claude.json` read as "this machine declares no servers".**
  The streaming reader checks the first character and nothing else, so a file
  cut off mid-document yielded zero values and zero errors. It now counts
  nesting as it goes: a stream that ends with an object or a string still open
  is an error naming that, and `list_mcp_servers` reports the source as
  unreadable instead of empty (`src/core/json-subset.mjs`).

- **The completion linter's newest rules existed only in English.** Agents here
  report in Russian, so the three rationalizations added for Д-10 — "these
  failures were pre-existing", "marked the criterion met from reading the code",
  "probably fine, I did not run the build" — walked through in the language they
  are actually written in. Their Russian halves are in. `pre_existing_failure`
  also gained an exemption, the second of its kind after "works on my machine
  **and in CI**": naming where it failed and carrying the fix over ("this test
  was already failing on main, and I ported the fix from PR 12") is a report
  with two facts in it, not an excuse. An exemption is read in the sentence its
  match sits in, so an honest sentence cannot cover for an excuse in the next
  one. Twenty-five phrasings: zero missed, zero false positives
  (`src/core/completion-claims.mjs`).

- **Worktree cleanup could not say what it had removed.** `cleanup_task_worktrees`
  stored only the removal outcome, which carries no `name` and no `state`, so a
  report of the cleanup could list paths and nothing else. Each record now
  carries the plan entry as well (`src/core/task-worktrees.mjs`).

- **A rollback called the agent's own files somebody else's.** "Never appeared
  in a snapshot of this task" means "written since the last snapshot", not
  "written by someone else" — and the warning claimed the second. It now says
  the same thing about every deleted file: all of them were written after the
  snapshot, by this task or by anyone else sharing the working tree, and here is
  the command that brings them back. The list that remains is named for what it
  is: `removed_unsnapshotted_files` (with `removed_snapshot_history_complete`),
  the paths for which the undo snapshot is the only record they existed
  (`src/core/task-snapshots.mjs`, `src/extensions/snapshots.mjs`).

- **A skill that says "do not trigger for code review" was picked for a code
  review.** The specialist slot scored the whole of `use_when`, so the sentence
  an author writes about when *not* to use a skill argued in its favour: a
  generalist took the reserved slot on a debugging task and a review task, both
  of which its own text excludes. The exclusion clause is now read separately
  and subtracts what it names — but only terms the rest of the text does not
  also name, since these sentences share their nouns, and never a function word
  (`src/core/task-vocabulary.mjs`). On the eight tasks of the original
  measurement no skill is now offered for a situation it excludes, and the
  database skill wins the migration review.

- **Imported skills could never be recommended.** All 101 skills imported from
  ECC were in the index and none of them ever reached an answer:
  `recommend_skills` returns three skills, deterministic routing fills all three
  with our own, and an imported skill's English `use_when` shares no substring
  with a Russian task. Routing now has reserved roles that do not consume the
  three (`RESERVED_ROUTING_ROLES`): `capability` as before, and a new
  `specialist` — one imported skill whose `use_when` answers the task's
  situation, offered beside the routed core rather than instead of part of it.
  The match runs through a new concept table (`src/core/task-vocabulary.mjs`)
  that translates what a Russian task names into the terms an imported catalogue
  is written in; it names concepts, never skills. A skill that declares an
  ecosystem is penalised when neither task nor project mentions it, and refused
  when the project has a stack and this is not it. Measured on eight typical
  tasks: five ECC skills recommended where there were none, and every task keeps
  the three skills it had.

- **Retired models' prices are marked as unverified.** Six rows in the rate
  table price models the published page no longer lists, so nothing re-checks
  them. They stay — a ledger keeps old events and a report over last quarter has
  to price what ran — but `usage_report` now keeps them out of the per-model
  breakdown (`historical_models` instead of `models`, each with
  `price_basis: "historical"`), reports `usage.historical_cost_usd` as the share
  of the total that rests on them, and says so in `rates.notice`. The totals
  still include them: dropping the cost would make them wrong the other way,
  silently. `include_historical_models` folds them back in. Current models'
  prices are untouched.

- **`list_mcp_servers` parsed the whole of `~/.claude.json` to reach two keys.**
  The same file holds Claude Code's conversation history for every project it
  has opened — tens of megabytes on an active machine. It is now streamed and
  only `mcpServers` and the current project's `projects[<path>].mcpServers` are
  buffered (`src/core/json-subset.mjs`), so another project's history and
  servers are never even recognised. Over two megabytes the report says what the
  read cost instead of hiding it, and a file that does not start a JSON object
  is reported unreadable rather than read as empty.

- **A .NET, F# or Xcode project was invisible to the detector.** Those project
  files are named after the product (`Atlas.csproj`), and the detector checked
  paths rather than listing the root, so `C#/.NET` was inferred from five
  conventional side files and `.csproj`, `.sln`, `.fsproj` and `.xcodeproj` were
  never seen. `createProjectDetector` now takes an injected `readDirectory` and
  reads the root's extensions. New stack labels with it: `F#`, `Perl` and
  `ArkTS/HarmonyOS`, plus rule packs for `perl` and `fsharp` — `arkts` is
  deliberately still unwritten, for the reason recorded in
  docs/ecc-upgrades/DEBTS.md, Д-18.

- **The static gate's size rules had no test.** Its five branches — a module
  over the ceiling, a pinned module that grew, a pinned module back under the
  ceiling, a pin for a module that no longer exists, and the main module over
  its own ceiling — lived inside the walk over the tree and could only be
  checked by breaking a real file and putting it back. They now live in
  `src/core/line-budget.mjs` as `evaluateLineBudget`, the gate is the input and
  output around them, and a test breaks each branch on its own input and reads
  the real `src/core` and `src/extensions` for zero findings.

- **The completion-statement linter blocked an honest report and missed three
  excuses.** "It works on my machine and in CI: both run the same command" was
  refused, because the "and in CI" exemption was only on the `locally` half of
  the pattern; it is now on both. "unrelated to this task" walked through
  because the rule required the word "change"; "should be fine" because the rule
  knew only "should work"; "I did not run the build" because the rule knew only
  "run the tests". A new `inspection_only` rule catches a criterion marked met
  from reading the diff rather than running it. Measured on fifteen phrasings —
  eight honest ones against a repository where nothing passed, seven excuses —
  kept as a regression test.

- **A rollback deleted files without saying which.** `rollback_task` brings the
  working tree to a snapshot's state, so a file written after it goes — possibly
  one a person wrote from another terminal. The answer now names every deleted
  file in `removed_files`, names again in `removed_unfamiliar_files` those the
  task has never snapshotted (the ones most likely not to be its work), and
  carries a `warnings` line saying how many went and which undo snapshot brings
  them back. Whose a file is cannot be told, and the answer does not claim to:
  it states what is checkable, and refuses the split rather than guessing when a
  snapshot's recorded file list was truncated.

- **A single policy rule could take the guard out of service.** A pattern that
  backtracks catastrophically — `(a|a)+$` needs 38.8 seconds against
  twenty-eight characters — passed `upsert_policy_rule`, and after that the
  guard stalled on every Bash command and every file write, because Node cannot
  interrupt a match in progress. Policy-rule matching now runs in a worker
  thread under a 250 ms budget with the input clamped to 4 KiB
  (`src/core/regex-budget.mjs`, mirrored in `hooks/lib.mjs` for the hook pack):
  a pattern that overstays is reported as unevaluated instead of never
  answering. `upsert_policy_rule` additionally refuses such a pattern up front
  by running it against input built from its own alphabet, so the refusal does
  not depend on recognising a pattern shape.

- The agent hook pack is now a working implementation rather than a condensed
  port. Three hooks did nothing at all before:
  - **File guard.** In `guard.mjs` the `else` branch holding every file-mode
    check was chained to the `if` *inside* the loop over shell patterns, so in
    `file` mode — where that loop never runs — the secret-bearing-file,
    secret-in-content and protected-configuration checks were unreachable.
    File mode now has its own branch and its own tests.
  - **Compaction advisor.** `compact-advisor.mjs` counted tool calls in a
    module-level variable, but the hook is a fresh process per call, so the
    counter was always 1 and the advisor never fired. The count is now
    persisted per session, and the primary signal is the real context size read
    from the transcript's most recent `usage` record, compared against the
    model's window.
  - **Session-end extraction.** `session-end.mjs` wrote a fixed stub record
    ("Hook-captured session") whatever the session contained. It now distils
    the transcript into user requests, tools used and files modified, and
    writes nothing when there is nothing to record.

### Changed

- The main module's line ceiling dropped to match what the extractions left
  (stage 1.7, which closes stage 1). `SYSTEM_LINE_CEILING` in
  `core/system-health.mjs` — the one place the gate and the System Dashboard
  both read — went from 10,150 to 5,076: the file's actual 4,776 lines plus 300
  of working room. The ratchet holds in one direction, so `mcp-stdio.mjs` can be
  edited but not re-grown; new capabilities belong in `src/extensions/`.
  - All five line-budget rules were verified by breaking each one deliberately
    against a throwaway module and reverting: an unpinned module over 800 lines,
    a pinned module grown past its allowance, a pinned module back under the
    ceiling, a `MODULE_LINE_EXCEPTIONS` entry whose module is gone, and the main
    module over its own ceiling. Both real pinned entries stayed:
    `core/frontend-product-quality.mjs` (1,222) and `core/reference-factory.mjs`
    (812) are still over the ceiling, and the comment claiming stage 1.3 would
    split them was corrected — that step built on top of them rather than out of
    them.
  - A system-health fixture pinned at a literal 9,800 lines became
    `SYSTEM_LINE_CEILING - 350`, so it keeps meaning "inside its budget" whatever
    the ceiling is.
- The task lifecycle moved out of `mcp-stdio.mjs` (stage 1.6 of the modularity
  plan, the last extraction step). `begin_task`, `checkpoint_task`, `verify_task`
  and `complete_task` became `src/extensions/lifecycle.mjs`, and the judgements
  under them became two tested modules in `src/core`: `task-verification.mjs`
  (whether a run passed, and which acceptance criteria it is evidence for) and
  `task-completion.mjs` (the completion note and what is left to do with the
  branch). Everything the four tools drive — the completion-claims linter, the
  plan gate, change hygiene, the context pack and its extras, evidence binding,
  skill outcomes, the Archify receipt store and the project-card writers —
  arrives through the extension host, and the four sibling tools they call
  (`recommend_skills`, `run_quality_gate`, `run_frontend_qa`,
  `prepare_pull_request`) arrive as host wrappers over the registry rather than
  through `callTool`, so a composed run still records one usage-ledger entry for
  the tool the client asked for and none for the work it delegated. Tool
  behaviour, response bytes, generated project and vault files, the task and
  usage state on disk, and the 116-tool list are unchanged; `mcp-stdio.mjs` lost
  a further 458 lines (5,233 → 4,775), which leaves it 5,243 lines below the
  10,018 it started at and past the plan's target of under 6,000.
  - `ARCHIFY_EVIDENCE_SCHEMA` left `tool-definitions.mjs` with the two tools
    that used it, so no tool definition is now shared across the two files.
- Project work moved out of `mcp-stdio.mjs` (stage 1.5 of the modularity plan).
  `run_quality_gate` became `src/extensions/projects.mjs`, and the pure half of
  project handling became four tested modules under `src/core`:
  `project-detection.mjs` (`detectProject` over an injected filesystem),
  `project-cards.mjs` (the registry card renderer and its section reader),
  `project-markdown.mjs` (the tables, bullet lists and section readers every
  generated project document shares) and `quality-gate-runner.mjs` (parsing a
  gate file, choosing what to run, and the verdict over a run). `detectProject`
  is a service rather than a tool — `begin_task`, `compile_project_context`, the
  card writers and four extensions call it — so it stays on the extension host;
  `mcp-stdio.mjs` binds it to the real filesystem and nothing else. Tool
  behaviour, response bytes, generated project and vault files, and the 116-tool
  list are unchanged; `mcp-stdio.mjs` lost a further 1,191 lines (6,424 → 5,233).
  - `detectProject` reads its filesystem through injected functions, so stack
    detection, the command fallbacks and the risk rules are now tested against a
    fixture tree instead of a repository on disk.
  - Two symbols no longer referenced by anything went with the move: a second
    `markdownList` and `buildProjectCardMd`, the flat card renderer that
    `buildRichProjectCardMd` replaced.
- Search moved out of `mcp-stdio.mjs` (stage 1.4 of the modularity plan). All
  thirteen search tools became `src/extensions/search.mjs`, over four modules in
  `src/core`: two services — `search-index.mjs` (the sqlite index, its freshness
  and the hybrid merge) and `embedding-workers.mjs` (the BGE-M3 worker pool and
  the one-shot fallback) — and two pure ones, `search-runtime.mjs` (presets,
  weight normalization, score explanations) and `search-eval.mjs` (the
  golden-case verdicts and ranking metrics). `csvValue` joined
  `core/text-format.mjs`. Both services are built once by `mcp-stdio.mjs` and
  shared: the system extension's health checks and every writer that calls
  `markSearchIndexDirty` reach them through the host. Tool behaviour, response
  bytes, generated vault files and the 116-tool list are unchanged;
  `mcp-stdio.mjs` lost a further 1,354 lines (7,778 → 6,424).
  - Both services take their process launchers as dependencies, so the worker
    protocol, the index freshness logic and the hybrid merge are now tested
    against stubs instead of a Python runtime and a 1024-dimension model.
- Frontend tools moved out of `mcp-stdio.mjs` (stage 1.3 of the modularity plan).
  Six tools left with their definitions, split by what they are for:
  `src/extensions/frontend-design.mjs` carries the Reference Factory
  (`plan_frontend_references`, `register_frontend_references`) and
  `generate_ui_ux_design_system`; `src/extensions/frontend-qa.mjs` carries
  `run_frontend_qa`, `run_visual_reference_qa` and `record_visual_review`. Their
  pure half became two tested modules under `src/core`:
  `reference-factory-artifacts.mjs` (manifest file paths, the registry entry, PNG
  structure and the artifact verdicts) and `frontend-qa-report.mjs` (the runner's
  input contract, the Markdown report, the review artifact list and the strict
  visual verdict). `mdCell` joined `core/text-format.mjs`. The frontend product
  state readers stay in `mcp-stdio.mjs` and reach the extensions through the
  host, because `compile_project_context`, `verify_task` and the product tools
  that have not been extracted yet all read them. Tool behaviour, response bytes,
  generated project and vault files, and the 116-tool list are unchanged;
  `mcp-stdio.mjs` lost a further 1,048 lines (8,826 → 7,778).
  - `run_frontend_qa`, `run_visual_reference_qa` and `record_visual_review` now
    have tests in a standalone checkout: the extension is driven against a
    deterministic stand-in for the browser runner, so the orchestration around
    Playwright is covered where the live-browser test is skipped.
- Skill registry tools moved out of `mcp-stdio.mjs` (stage 1.2 of the modularity
  plan). `rebuild_index`, `validate_skill_library` and `recommend_skills` are now
  one extension, `src/extensions/skills.mjs`, reaching the vault, the collectors
  and the embedding backend through the extension `host`; their definitions moved
  with them out of `tool-definitions.mjs`. The pure half became five tested
  modules under `src/core`: `skill-catalog.mjs` (generated-note paths and the
  item predicates), `skill-cards.mjs` (card rendering), `skill-registry-docs.mjs`
  (registry files and their Markdown), `skill-quality-report.mjs` (the validation
  verdict and its dashboard), `skill-recommendation.mjs` (task intent and
  ranking), plus `text-format.mjs` for the text primitives they share.
  `applySkillOverlays` joined `src/core/skill-overlays.mjs`. Tool behaviour,
  response bytes, generated vault files and the 116-tool list are unchanged;
  `mcp-stdio.mjs` lost 1,192 lines (10,018 → 8,826).
- Session and instinct memory is shared across the worktrees of one clone.
  `repository_id` is now derived from `git rev-parse --git-common-dir` (plus the
  project's path inside its worktree), which is identical in the main checkout
  and in every linked worktree, and `SessionStore`, `InstinctStore`, the
  context-extra providers and the `session-start` / `session-end` hooks key
  memory by it — so a handoff saved inside a `begin_task_in_worktree` worktree
  resumes from the main checkout and back. Tasks stay keyed by `project_id`, so
  they remain bound to the working tree they were started in. Records written
  under the old `project_id` are still read and move to the repository key on
  the first write. `repository_id` was previously a hash of the `origin` remote,
  which is still reported as `git.remote` by `project_identity`.
- Package-manager split is now explicit: `packageManager` fields plus a
  `CONTRIBUTING.md` policy section pin `ai-dev-mcp-server/` to npm and
  `frontend-qa/` to pnpm. `resolveSpawnInvocation` no longer silently runs an
  npm command through a bundled pnpm entrypoint — it fails closed instead.
- `npm run docker:audit` now prints a clear "run `npm run docker:prepare` first"
  message when the build context is missing, instead of an `ENOENT` stack trace.
- Minimum Node.js is now 22.12 (was 24). No Node 24-only API is used; `.nvmrc`
  pins `22`, `bootstrap.ps1` accepts 22.12+, and CI adds a Node 22.12 floor job
  (lint + core tests) alongside the Node 24 gate.

### Fixed

- The test suite is isolated from the developer's real `~/.ai-dev` tree: every
  `node --test` run loads `test/setup.mjs`, which pins the `AI_DEV_*` runtime
  roots (task/skill/pilot state, search index, Frontend QA and Archify
  artifacts, model dir) to a throwaway temp directory and exports
  `PYTHONDONTWRITEBYTECODE=1`.
- Python helpers (`search_cli.py`, `bge_m3_worker.py`, `bge_m3_embed.py`, the
  UI/UX Pro Max search script) run with `-B`, so `query_ui_ux_knowledge` and
  friends no longer drop `__pycache__/*.pyc` into the checked-in public seed and
  break the next `npm run docker:prepare`.
- `copyDistributionTree` skips forbidden runtime directories (`__pycache__`,
  `.venv`, `node_modules`, …) while copying, so a stray directory left behind by
  a local tool run can no longer fail the Docker context privacy audit.

### Fixed

- Privacy-audit term gathering no longer aborts when `os.userInfo()` throws.
  `ownerUsername()` falls back to `USER` / `USERNAME` / `LOGNAME`, so
  `bootstrap.sh --build-local` (which runs the context scripts inside
  `docker run --user "$uid:$gid"`) works on macOS and on any Linux host whose
  uid is not the image's baked-in `1000`.

### Fixed

- Command policy (`run_quality_gate` / `verify_task` / Frontend QA dev servers)
  now positively allowlists every argument: it rejects code-loading and
  output-redirecting flags (`--require`, `--import`, `--loader`,
  `--test-reporter`, `-c`/`-e`/`-p`, `--config`, `--prefix`/`--dir`/`--cwd`,
  `--output`, `go test -exec`, `cargo test --config`, …), inline Python fused
  with `-c` (`python "-cimport os;…"`), Python scripts referenced by absolute
  path or `..`, package-script "names" that are file paths, and `git diff
  --check` with any flag other than `--cached`/`HEAD`. Executables and path
  operands must resolve inside the project; `validateProjectExecutable` now also
  rejects relative executables (`../../tmp/evil/pytest`), not just absolute ones.

### Fixed

- `path-policy` no longer lets a write pass through a symlink whose target lives
  outside the trusted root: a final-component symlink is `lstat`-checked, and a
  dangling one is rejected with a `PathPolicyError` instead of being treated as
  a new file. The async `resolveWithin` now raises a `PathPolicyError` (not a
  raw `ENOENT`) when a dangling link or a missing path is read.

### Fixed

- Completion evidence is now bound to file *contents*, not just `git status`
  output: `captureProjectState` hashes every dirty/untracked file into the
  fingerprint, so editing an already-dirty file after `verify_task` invalidates
  the evidence. A non-git project directory now gets a real bounded
  `path/size/mtime` fingerprint (strength `medium`) instead of a constant hash
  of its path.
- `complete_task` now honours **only the most recent** verification: it must
  exist, must have passed, and must match the current project fingerprint. A
  later failed run, an edit after the last passing run, or a second completion
  of an already-complete task is refused with a specific message.

### Fixed

- `execFileWithInput` (Frontend QA runner, UI/UX helper) now bounds captured
  output at 16 MiB, kills the whole process group on timeout or overflow so a
  Playwright Chromium or dev server is not orphaned, guards against a
  double-settle, ignores `stdin` `EPIPE`, and decodes stdout/stderr from a
  buffer so multi-byte characters are no longer corrupted at chunk boundaries.

### Fixed

- `ensureSearchIndex` claims the in-flight refresh slot before its first
  `await`, so concurrent search calls join one rebuild instead of each
  starting their own `search_cli.py rebuild` on the same SQLite file. A
  "dirty" reason raised while a rebuild is running is no longer cleared, so
  the next search still rebuilds.

### Fixed

- `verify_task` no longer trusts client-supplied Archify quality numbers. Every
  real `archify_deliver` / `archify_visual_check` run now writes a server-owned
  receipt (keyed by the artifact's SHA-256) under
  `~/.ai-dev/state/archify-receipts`; delivery-criterion validation hashes the
  file on disk, looks up that receipt, and evaluates the showcase bar against
  the recorded numbers. A forged evidence entry with no matching receipt fails
  the check.

### Fixed

- The skill-outcome and pilot stores no longer strand every future write after a
  single failed `update` (for example a transiently corrupt state file): the
  internal serialisation chain is always recovered, while the failing caller
  still sees the real error.

### Fixed

- Hybrid search no longer fails when the local BGE-M3 dense backend is missing.
  `hybrid_search`, `preset_search`, `explain_search`, and `run_search_eval` now
  pre-check the worker script, Python runtime, and model weights, fall back to
  keyword/sparse ranking, and report a `dense_available: false` warning instead
  of throwing "BGE-M3 Python runtime not found". Keyword-only ranking can be
  forced with `AI_DEV_DENSE=off`.

### Fixed

- A crashed BGE-M3 embedding worker no longer takes the whole MCP process
  down: `getBgeWorker` handles `stdin` `error` (EPIPE), a worker that reported
  a failed model load is rejected immediately instead of after the request
  timeout, and idle workers are reaped after ten minutes.

### Fixed

- `verify_change_hygiene` findings now use one shape everywhere:
  `{ rule, severity, file, line, message, excerpt }`. The tool returned `code`
  and `path` while the docs and the `verification-loop` skill spoke of `rule`
  and `file`, so an agent following the skill read `undefined`. `excerpt` is
  always present, a schema test pins the field list, and the docs, the tool
  description and the skill were corrected.

### Fixed

- `save_session` accepts both spellings of the failure reason. ECC's
  save-session prompt (and the example in `docs/ecc-upgrades/09-session-memory.md`)
  writes `failed: [{ approach, why }]` while the schema said `reason`, so the
  explanation was silently dropped and `resume_session` printed "reason not
  recorded". `why` is now normalized into `reason`; the examples and the file
  states in them (`status`, not `state`) match the schema.

### Fixed

- `usage_report` counts every tool call, not only the ones that arrived over
  MCP. Recording moved from the `server.mjs` transport into `callTool` itself,
  so calls from `scripts/ai-dev.mjs`, the smoke scripts and tools composed from
  other tools are in the ledger too; the transport only passes its own overhead
  as `transportMs`. One call is still exactly one event — pinned by a test that
  compares a direct call, a call through the transport, and a failure.

### Added

- `install_project_rules` target `claude-md`: instead of copying the rules into
  `.claude/rules`, it writes an `## Engineering Rules` section into `CLAUDE.md`
  that imports the canonical files with `@.ai-dev/rules/common/<rule>.md`, which
  Claude Code expands at session start. One line per file, because an import is
  a path and not a glob; path-scoped packs stay listed as plain paths. The
  target is opt-in — it replaces the `claude` target rather than adding to it,
  and asking for both returns a warning.

### Fixed

- The agent hook tests run in the Windows CI job, and the hooks work there. The
  pack runs on the developer's machine, so Windows is a first-class target:
  `.github/workflows/ci.yml` gained an "Agent hook tests" step
  (`src/core/agent-hooks.test.mjs` and `src/extensions/hooks.test.mjs`), and
  three Windows-only path bugs are fixed rather than skipped.
  - `projectRootOf` resolves the root with `fs.realpathSync` instead of
    `fs.realpathSync.native`. The server resolves it with `fs.realpath`, and the
    native variant additionally expands 8.3 short names on Windows
    (`RUNNER~1` → `runneradmin`), so hook and server keyed two different
    `project_id`s for the same repository — the hook's handoffs and instincts
    landed where the server never looked.
  - Project paths are compared with a new `samePath` helper (case- and
    separator-insensitive on Windows), so `session-start` and `stop-check` find
    the project's open tasks.
  - `session-end` writes repository-relative paths with `/` separators, so a
    captured handoff lists `src/login.js`, not `src\login.js`.
  Temp-directory cleanup in those tests retries, because Windows holds handles
  on freshly written git objects for a moment.

### Fixed

- Intermittent failure in `src/extensions/system.test.mjs` (roughly two runs in
  ten under load): the fixture wrote the skill-routing report before the eval
  cases it is compared against, so whenever the two writes landed in different
  milliseconds the `skill_routing_benchmark` check called the report stale, that
  critical check failed, and the health status came out `fail` instead of
  `degraded`. The cases are written first now.

## [1.0.0] - 2026-09-01

First tagged release.

### Added

- Local `stdio` MCP server (`@modelcontextprotocol/sdk`) exposing repository
  context, a knowledge base, a managed skill library, hybrid search, quality
  gates, Frontend QA, and a verifiable task lifecycle
  (`begin_task` → `checkpoint_task` → `verify_task` → `complete_task`).
- Hybrid search: SQLite FTS, sparse aliases, deterministic intent candidates, and
  an optional local BGE-M3 reranker.
- Public skill seed under `docker/public-seed` (system rules, prompts, quality
  gates, custom workflow skills, MIT-licensed design knowledge).
- Multi-arch Docker image published to GHCR with SBOM and provenance, a hardened
  default runtime (no network, non-root, read-only rootfs, no capabilities), and
  an allowlisted build context that never includes a personal vault.
- Cross-platform bootstrap (`bootstrap.ps1`, `bootstrap.sh`), a fast-start
  launcher / `ClaudeMcpProxy`, Arch `PKGBUILD`, and a Homebrew formula.
- `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/RECOVERY.md`; JSDoc types for
  every exported `src/core` function; ~86% line coverage on `src/core`.
- CI: static-quality, security, packaging, and vault-free unit gates (`ci.yml`);
  a `vault-suite` job runs the full vault-coupled test suite plus the protocol and
  lifecycle smokes against the bundled seed; privacy-policy, context-audit,
  image-build, and GHCR publish (`docker-publish.yml`).
- `npm run skills:ensure-index` / `scripts/ensure-skill-index.mjs`: builds the
  bundled seed's skill registry on demand so a standalone checkout can route
  skills.
- English `README.md` (Russian preserved at `README.ru.md`), and root
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and this changelog.
- BGE-M3 weight-download instructions for the source and Docker paths.
- `.nvmrc` pinning Node 24.

### Changed

- Agent-neutral runtime: regenerable data resolves under `~/.ai-dev`
  (`AI_DEV_HOME`) with per-directory `AI_DEV_*` overrides and a `~/.codex`
  fallback for migrated installs. Launchers, helper scripts, the Docker image,
  and the client installer use `node` / `python3` from `PATH`. Documentation and
  the shipped `mcpServers` snippet are client-neutral.
- Vault root resolution: a checkout with no full vault falls back to the bundled
  `docker/public-seed`, so the server and tests work from source without
  `AI_DEV_VAULT_ROOT`. `npm run check` provisions the seed skill registry first,
  so it passes on a fresh clone.

### Fixed

- Vault-coupled tests that require the full production skill catalog or the
  Playwright frontend-qa runner now `skip` when those fixtures are absent instead
  of failing a standalone checkout.
- `buildDockerClientServerConfig` resolves `AI_DEV_PROJECT_PATH` with the path
  API for the requested `platform`, so a Windows client config generated on a
  non-Windows host is no longer mangled; the installer tests pin `platform`
  explicitly instead of relying on `process.platform`.

### Changed

- The `.cursor/hooks.json` adapter is versioned and its contract is pinned.
  `CURSOR_HOOKS_CONTRACT` records the format version the adapter writes, the
  date it was checked, the sources it was checked against, and the limits that
  follow from it; `cursorHooksDocument(profile, { version })` dispatches to a
  builder per format version and refuses an unknown one, so the next Cursor
  format gets its own builder instead of a silent rewrite of this one.

  What the 2026-09-10 check actually established, since `cursor.com` is
  unreachable from the sandbox this ran in and no live Cursor was available:
  the format version and the deny shape are **corroborated** — two independent
  secondary sources agree that Cursor declares `"version": 1` and that a
  blocking hook answers `{"permission":"deny"}` with optional `userMessage` /
  `agentMessage`. The **event names are not**. The JSON schema published by the
  source package (`johnlindquist/cursor-hooks`) allows exactly six events —
  `afterFileEdit`, `beforeMCPExecution`, `beforeReadFile`,
  `beforeShellExecution`, `beforeSubmitPrompt`, `stop` — with
  `additionalProperties: false`, and mentions `sessionStart`, `sessionEnd` and
  `preCompact` nowhere. Those three are exactly what this adapter registers for
  session memory. Either that package (v0.1.0, last touched 2025-10) lags
  Cursor 3.x, or the three registrations are inert and Cursor-side session
  memory never runs — which would also make the unconfirmed-draft handling
  below dead on Cursor, since no draft would ever be captured. `stop` is a
  documented event and is the obvious home for the capture if it comes to that.
  This is a reconstruction from secondary sources, not a verification: settle it
  against a real Cursor before trusting the Cursor memory story.
  `CURSOR_HOOKS_CONTRACT.verification` records the same, claim by claim, so the
  distinction survives in the code and not just here. The tests pin what the
  adapter writes, so a change still fails CI rather than the user's install.
- `install_agent_hooks` reports what the merge could not decide instead of
  writing over it: a `.cursor/hooks.json` that declares another format version,
  and events where a foreign hook is registered ahead of ours (on the
  unverified premise that Cursor runs the first entry of an event, so that one
  would shadow the guard; the warning costs nothing either way). `agent_hooks_status`
  reports the installed file's `cursor_format_version` and whether this adapter
  builds it.
- Hook-captured sessions are drafts, not handoffs. `session-end.mjs` writes
  `confirmed: false`, and every reader says so: `resume_session` returns
  `unconfirmed: true` plus the drafts still waiting, its briefing opens with
  "UNCONFIRMED HOOK DRAFT — the Stop/PreCompact hook distilled this from the
  transcript" and does not invent a next step the hook cannot know, and the
  `session-start` context injection carries the same caveat — as does the
  compiled context pack, whose handoff section is titled "unconfirmed hook
  draft" when the newest record is one. `save_session` with
  `confirm_hook_draft: true` promotes one: the agent's fields win, the draft
  fills the rest, the stored record is marked `confirmed` with `confirmed_from`,
  and the draft file is deleted so nothing is offered as unconfirmed twice.
  Records written before the flag existed are treated as drafts — they came from
  the same hook.

### Fixed

- `compact-advisor.mjs` reads the context size from the newest **assistant**
  message in the transcript. It scanned for any entry carrying a `usage` field
  and took the first one it found from the end, so a subagent's turn
  (`isSidechain: true`, billed against its own window) or a non-assistant record
  could set the number the advice was based on — and the tail slice's first,
  half-read line was parsed as if it were whole. Parsing moved into
  `hooks/lib.mjs` (`latestAssistantUsage`, `contextWindowFor`,
  `compactSettings`, `contextThresholdFor`) and is unit-tested against a
  transcript fixture. Every threshold is now settable in `.ai-dev/policy.json`:
  `compact_tool_threshold`, `compact_tool_interval`,
  `compact_context_threshold` (absolute; 0 derives it from the window),
  `compact_context_thresholds.standard` / `.large`, `compact_context_window`
  and `compact_context_interval`, each falling back to its default when the
  value is missing or not a positive number.

[Unreleased]: https://github.com/stonebridgeway/ai-dev-system/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/stonebridgeway/ai-dev-system/releases/tag/v1.0.0
