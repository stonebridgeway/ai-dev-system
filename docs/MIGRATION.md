# Moving from 2.x to 3.0

[← README](../README.md) · [Install](INSTALL.md) · [Upgrade test](UPGRADE-TEST.md) · [Changelog](../CHANGELOG.md)

3.0 is the same server. An agent sees 135 tools — two more than 2.0.0, `plan_security_fixes` and
`render_knowledge_galaxy` — and an app can opt into 16 more; the vault and the task state keep their
format, and the index 2.x built is read without a rebuild. What changed is how AI Dev is installed,
how a client reaches it, and where it keeps a few things. A 2.x install goes on working after the
update, except where this page says otherwise: it says what changes for it, what moves by itself on
the first start, what needs one command from you, and how to go back.

`npm run upgrade:test` checks all of it against a 2.x clone, and `npm run docker:upgrade-check --
--old-image <2.x image> --new-image <image>` the Docker part against a 2.x volume and its launchers
([Upgrade test](UPGRADE-TEST.md)).

## In short

| You have | Do this | Then |
| --- | --- | --- |
| A 2.x clone, set up with `npm run setup` | `git pull`, then `cd ai-dev-mcp-server && npm ci && npm run setup`; restart every AI client | One `ai-dev` entry per client, served by one daemon; your vault, tasks and index as they were |
| 2.x through Docker (`bootstrap.sh`, `bootstrap.ps1`, `run-mcp.sh`, `run-mcp.ps1`, `ClaudeMcpProxy.exe`) | `git pull`, then run `bootstrap.sh` (`bootstrap.ps1` on Windows) again — it keeps the projects folder and the model folder your 2.x entries name; restart every AI client | `docker run` entries; the volume kept, its skills brought up to the 3.0 seed; on macOS and Linux, 2.x's long-lived container removed (2.x kept none on Windows) |
| A 2.x install you are not ready to touch | Nothing yet | It keeps working, and the warnings below say what to run when you are |
| 2.x on a Mac | Stay on 2.x for now: macOS is in development, and 3.0 is released for Windows and Linux only. Do not `git pull`; with Docker, point 2.x's launchers at the 2.x line, `AI_DEV_IMAGE=ghcr.io/stonebridgeway/ai-dev-system:2`, since `:latest` becomes 3.x with the release ([The way back](#the-way-back)) | 2.x as it is, until 3.0 is accepted on a Mac |

A new machine needs none of this: install 3.0 [any of the three ways](INSTALL.md#choose-a-path).

## Everyone

- **The licence changes.** 3.0 is under the [PolyForm Noncommercial License 1.0.0](../LICENSE),
  © 2026 stonebridgeway: personal use, study, research, hobby projects and noncommercial
  organisations are free, changes included; using 3.0 commercially — at work, in a company's product
  or service — needs a commercial licence from the author ([Telegram @stonebridgeway](https://t.me/stonebridgeway)). 2.x was released under MIT and stays under
  it: an install that does not update keeps those terms.
- **The server's name in a client is `ai-dev`.** 2.x wrote `ai-dev-system` for a local install and
  `ai-dev` for Docker, and a client could hold both. `setup` and `clients install` write one `ai-dev`
  entry, remove the `ai-dev-system` one and say so; each client keeps one `ai-dev`, the last install
  to connect it wins. A 2.x entry keeps working until 4.0 (`clients list` labels it `(2.x)`), and every
  file changed has its previous bytes beside it as `<file>.backup-<time>`.
- **Node 22.16 or newer** (or 24+) for a local install; 2.x accepted 22.12. On an older Node the
  server starts, and the search tools answer with the version they need. Docker needs no Node on the
  host, except `bootstrap.ps1` on Windows (22.12+).
- **No Python.** Search, its index and the local model run in Node; the Python search helper is gone.
  Python is left to the two UI UX Pro Max tools, which say what to install without it.
- **The Python dense backend is removed.** One command moves you to the ONNX model:
  `npm run setup -- --model` in a clone, `npx ai-dev-system setup --model` with npx. It
  embeds the documents again; the Python vectors are another model's, kept but not compared, until it
  replaces them. `AI_DEV_DENSE_BACKEND=python` is read as `auto` with a note; `BGE_M3_PYTHON`,
  `AI_DEV_EMBEDDINGS_PYTHON`, `AI_DEV_PYTHON_BASE`, `BGE_M3_PYTHON_REVISION` and `BGE_M3_MODEL_DIR`
  are named by the health check and not read — remove them, and delete `~/.ai-dev/models/bge-m3`.
  `--dense-python` still works and does what `--model` does. An Intel Mac has no build of the ONNX
  runtime: there dense search is off, and search works by words.
- **`AI_DEV_HOME` is the runtime folder itself.** 2.x put the tree one level down, in
  `$AI_DEV_HOME/.ai-dev`; the server, `setup` and every `ai-dev` command move it up when they start,
  without overwriting anything, and `ai-dev doctor` reports what moved (check `runtime_home`).
  `AI_DEV_HOME` set to your home folder keeps its 2.x meaning. Hooks installed into a repository look
  for the old place until you run `install_agent_hooks` there again.
- **`.codex` is no longer read.** What AI Dev kept there in its Codex days moves into the runtime home
  once, recorded in `state/runtime-home-migration.json`: from `~/.codex` into `~/.ai-dev`, or, with
  `AI_DEV_HOME` set, from `$AI_DEV_HOME/.codex` — where 2.x read it for that install — into
  `$AI_DEV_HOME`. The rest of `.codex` is Codex's own and stays, and `npm run demo` moves nothing out
  of it.
- **One daemon serves every client.** A 3.0 local entry, `ai-dev mcp`, hands the client to one warm
  server per install and environment, so the index and the model are loaded once. A 2.x entry
  (`node …/src/server.mjs`), `npm start` and `AI_DEV_DAEMON=0` keep one process per client, as 2.x
  did.
- **Agent hooks.** Hooks 2.x installed keep running wherever `node` is on the client's `PATH`. Run
  `install_agent_hooks` again in each repository for the 3.0 registrations, which start through
  `.ai-dev/hooks/with-node.sh` and find Node without it; your own hooks are kept. The hooks it
  installs bring two defaults 2.0.0 did not have, under the standard and strict profiles. Before an
  install command runs, the guard looks the package up in the npm registry and on OSV, and refuses
  malware and a release younger than 24 hours: package names go to api.osv.dev. And when code or a
  dependency manifest changed after the last `run_security_scan`, the Stop hook sends the agent back
  once to run the security review before the session ends. In `.ai-dev/policy.json`,
  `"supply_chain": { "osv": false }` keeps package names from OSV and `"enabled": false` turns the
  check off (so does `AI_DEV_SUPPLY_CHAIN=off`); `"security_review_on_stop": "remind"` only tells you,
  and `"off"` says nothing.
- **The skill catalogue** is 614 skills, not 3,228: the Membrane connectors were cut from 3,074 to the
  460 a developer reaches for. A skill the update removed is dropped from the registry, and found no
  more.
- **Search.** `AND`, `OR`, `NOT` and `NEAR` in capitals are words, no longer query syntax.
  `search_knowledge` searches what the index holds — notes, skills by their registry entry and card,
  project cards — so a skill's reference files (`read_skill` reads them) and notes in folders such as
  `build` or `.next` are no longer found by it. The dashboard is stale once after the update:
  `ai-dev dashboard` rebuilds it.
- **The task tools answer with a summary.** `begin_task`, `begin_task_in_worktree`,
  `checkpoint_task`, `verify_task` and `complete_task` return the task, its criteria and what changed,
  not the whole task record; a check command that passed comes without its output, and the long
  output of one that failed is cut to its first 1,200 and last 800 characters. A script or a client
  that read the record from those answers reads it from `get_task`, passes `include_details: true`,
  or sets `AI_DEV_RESPONSE_MODE=full` in the client's environment, which answers as 2.x did.
  `search_skills`, `browse_skill_group` and `list_skill_groups` answer with short rows
  (`include_details: true` for every field), and an answer's JSON comes without indentation.
- **New files** in the runtime home: `<file>.lock` beside the files several processes write,
  `run/` (the daemon's descriptors), `logs/daemon.log`, `state/mcp-clients.json`. 2.x ignores them.

## A clone

`git pull`, then `cd ai-dev-mcp-server && npm ci && npm run setup`. `npm ci` needs no flag: the
package's `.npmrc` keeps dependency install scripts off. Restart every AI client afterwards — a 2.x
server process still running calls the search helper the pull deleted.

What moves by itself: the 2.x index and its vectors are read as they are, the task state and the
vault are untouched, and the skill registry follows the pulled catalogue. What needs a command: the
`ai-dev` entries (`npm run setup` writes them), the hooks (`install_agent_hooks`), and the model if
you used the Python backend (`npm run setup -- --model`).

## Docker

- **Your 2.x configs keep working.** They name a launcher — `docker/run-mcp.sh`, `run-mcp.ps1`, or for
  Claude on Windows `ClaudeMcpProxy.exe` — which runs the new image until 4.0. The 3.0 copies of the
  scripts say so on stderr: *"ai-dev: this client config runs docker/run-mcp.sh, the 2.x launcher,
  which works until 4.0. Run ./bootstrap.sh (or `ai-dev clients install --docker`) to write the 3.0
  entry …"*. An installed `ClaudeMcpProxy.exe` is 2.x's own build: it answers the handshake itself,
  without the server's instructions and without a warning, until `bootstrap.ps1` replaces its entry.
- **`git pull`, then bootstrap.** 2.x's `run-mcp.sh` ran every session in a long-lived container, so a
  `docker pull` alone does not reach your sessions. Run `bootstrap.sh` (`bootstrap.ps1`) again: it
  writes `docker run -i --rm …` entries in their place and — on macOS and Linux — removes the
  container 2.x kept, `ai-dev-system-runtime-<uid>`, once every config is rewritten. It mounts the
  folders your entries name and says which it kept: the projects folder of their
  `AI_DEV_PROJECT_PATH`, and the model folder of their `AI_DEV_MODEL_PATH` — but not one that holds
  2.x's Python model and no `bge-m3-onnx/`, which 3.0 does not run; a folder an entry names that is
  not an absolute path is not kept either, and a lookup that fails is said. `--project-path` (`-ProjectPath`) and `--model-path` (`-ModelPath`) name
  others; with no entry to read, the projects folder is `~/AI-Dev-Projects` and no model folder is
  mounted. Entries that name different projects folders stop it (bootstrap.sh exits 64) until you
  name the one to keep.
- **The volume is kept.** Its first start under the new image takes about 15 seconds, once. Its skills are
  brought up to the 3.0 seed by the seed's manifest instead of 2.x's copy-if-missing: what only 2.x
  shipped is removed; a seed file you edited keeps your edit, with the update beside it as
  `<file>.seed-new` until you merge it (`ai-dev doctor` names each one); your own skills are not
  touched. A runtime tree 2.x left one level too deep (`.ai-dev/.ai-dev`) moves up.
- **The state moves to your machine** — `~/.ai-dev/state`, where the agent hooks keep theirs — where
  the container's user, uid 1000, is you: macOS, Windows, and Linux for the first user. The tasks and
  handoffs in the volume move there on the first start. With another uid, or rootless Docker,
  userns-remap or Podman, the state stays in the volume as in 2.x, and the server cannot write into
  your projects; there the local install is the one to take.
- **The projects are mounted at their own path** on macOS and Linux, not at `/workspace`. What the 2.x
  server remembered of a project — sessions, instincts, decisions — stays under `/workspace/<name>` in
  the state, and is not moved: with the projects at their own path the server starts their memory
  afresh. On Windows they stay at `/workspace`.
- **What the image keeps:** `/opt/ai-dev/app` and `/opt/ai-dev/public-seed` (now links), the command,
  the `/data` volume, the user, and the data variables. **What it no longer has:** Python, Playwright
  and Chromium (they are in the `-browser` variant, `:latest-browser`), `/opt/ai-dev/search-index`,
  and the `BGE_M3_ONNX_DIR` and `AI_DEV_DENSE_INSTALLED` variables. A build passing
  `INSTALL_BGE_M3=1` is told what replaced it — on screen with `--progress=plain`, since BuildKit's
  terminal view folds a finished step's output; a step taken from the cache prints nothing, so a later
  build of the same tree shows it only with `--no-cache`.
- **`AI_DEV_DOCKER_NETWORK` is read by the 2.x launchers only.** A 3.0 entry has `--network none`
  written into it: a project whose checks need the network gets `--network bridge` there, and running
  bootstrap again puts `none` back.
- **A model on the host** is mounted at `/models` (`AI_DEV_MODEL_PATH`, `--model-path`), and the
  variable names the folder above the models — `~/.ai-dev/models`, holding `bge-m3-onnx/`. In 2.0.0 it
  named the model's own folder, mounted at `/models/bge-m3`: the 2.x launchers refuse that value now
  (`run-mcp.sh` with exit 64) and say to name the folder above it. A folder that holds only `bge-m3/`,
  the removed backend's weights, is named as that by the 2.x launchers. When its `bge-m3-onnx` is a
  link to another disk, a 3.0 entry mounts the link itself. Or put the model into
  the volume once: `docker run --rm -it --network bridge --mount
  type=volume,source=ai-dev-system-data,target=/data ghcr.io/stonebridgeway/ai-dev-system:latest ai-dev
  model install`.
- **Bootstrap installs nothing.** It checks for Docker and says where it comes from;
  `--install-prerequisites` is accepted and answered with that.
- **Tags**: `:latest` moves only with a release tag of the newest line, and no longer
  with 2.x; `:edge` follows `main`; `:2` follows the 2.x line — 2.x's `:latest`, copied to it before
  3.0 is tagged, and after that moved only by a `v2.*` tag.

## Windows

- **A 2.x clone** wrote `AI_DEV_PYTHON=python3` into the clients, which a Windows Python does not
  answer to. `npm run setup` (or `npm run clients:install`) writes the 3.0 entry: `ai-dev`, Node by its
  full path, no `AI_DEV_PYTHON`.
- **`bootstrap.ps1`** rewrites Claude Desktop — which ran `ClaudeMcpProxy.exe` — and the other clients
  to `docker run … /workspace`, and brings `C:\ProgramData\AI-Dev-System\run-mcp.ps1` up to date if it
  is there. It compiles nothing, and it no longer installs Docker Desktop or Node: it needs both
  (Node 22.12+) and says how to install them.
- **Under Docker on Windows** the state folder is shared, but only its usage ledger is one: the server
  sees a project as `/workspace/<name>`, the hooks as `C:\…\<name>`.
- **The Windows installer** is new in 3.0, with a layout of its own: there is nothing of 2.x for it to
  move. It and a clone or Docker install can sit side by side; each client keeps the `ai-dev` entry the
  last of them wrote.

## What stays until 4.0, and what it says

| 2.x | 3.0 | Until 4.0 |
| --- | --- | --- |
| `docker/run-mcp.sh`, `run-mcp.ps1` in a client config | `docker run` entries (`bootstrap.sh`, `bootstrap.ps1`) | run the image; say on stderr that they are the 2.x launcher |
| `ClaudeMcpProxy.exe` for Claude on Windows | a `docker run` entry | works as installed; no longer compiled |
| the server name `ai-dev-system` | `ai-dev` | works; `clients list` labels it `(2.x)` |
| `node ai-dev-mcp-server/scripts/ai-dev.mjs` | `ai-dev` (`bin/ai-dev.mjs`) | runs every command; says so on stderr |
| `scripts/install-local-mcp-clients.mjs` | `ai-dev clients install` | writes the four clients 2.x wrote; says so |
| `scripts/start-local.ps1` | `ai-dev mcp` | runs it; says so |
| `scripts/backup-ai-dev-system.ps1`, `restore-ai-dev-system.ps1`, `restore-runtime.ps1`, `run-acceptance.ps1` | `ai-dev backup`, `ai-dev restore`, `npm ci` + `ai-dev setup --frontend-qa`, `npm run check` | run them; say so |
| `--dense-python`, `AI_DEV_DENSE_BACKEND=python` | `--model` | the ONNX model, with a note |
| `INSTALL_BGE_M3=1` (image build) | the model in the volume, or at `/models` | says what replaced it (`--progress=plain` keeps it on screen; a later build of the same tree, only with `--no-cache`) |

Removed outright, being internal or never released: `scripts/install-docker-mcp-clients.mjs` (only
bootstrap and CI ran it), `npm run test:search-helper`, `search-index/search_cli.py` and the image's
`/opt/ai-dev/search-index`, `embeddings/`, and the Homebrew formula and the AUR package
(`packaging/`), which were never published.

## The way back

- **A clone.** In `ai-dev-mcp-server`, before you check 2.x out: `npm run ai-dev -- daemon stop`, and
  `npm run ai-dev -- clients remove`, which takes both `ai-dev` and the 2.x `ai-dev-system` out of
  every client — a file nothing else has changed since gets back what it held, without either entry.
  Then `git checkout <the 2.x commit>` and `npm ci --ignore-scripts`. 2.x's `npm run setup` never
  connected the clients: connect them again with 2.x's `npm run clients:install`, which writes Cursor,
  Gemini, VS Code and Claude Code, or restore each client's file from the `<file>.backup-<time>`
  beside it that dates from before the update. 2.x reads the index 3.0 wrote; for an `AI_DEV_HOME`
  that 3.0 moved up, give 2.x `AI_DEV_STATE_ROOT=$AI_DEV_HOME/state` and
  `AI_DEV_SEARCH_INDEX_DIR=$AI_DEV_HOME/cache/search-index`.
- **Docker.** `sh ./bootstrap.sh --image ghcr.io/stonebridgeway/ai-dev-system:2` keeps the folders the
  3.0 entries mount and writes entries that run the 2.x image with 3.0's mounts: it sees the state folder, and the tasks that moved there. Run by
  2.x's own launchers (`AI_DEV_IMAGE=ghcr.io/stonebridgeway/ai-dev-system:2`), it keeps its state in the
  volume and does not see those tasks — [Upgrade test](UPGRADE-TEST.md) says how to copy them back.
  Either way 2.x's copy-if-missing puts back the skills 3.0 dropped, and the next 3.0 start removes
  them again. `:2` exists once 3.0 is released — 2.x's `:latest`, copied to it before the 3.0 tag;
  until then the 2.x image is `ghcr.io/stonebridgeway/ai-dev-system:latest` itself, which is also
  the installer bootstrap uses by default, so `AI_DEV_INSTALLER_IMAGE` names the 3.0 image you built
  to write the entries: `AI_DEV_INSTALLER_IMAGE=ai-dev-system:local sh ./bootstrap.sh --image
  ghcr.io/stonebridgeway/ai-dev-system:latest`. Docker's "pull access denied for ai-dev-system …"
  is expected there: bootstrap tries to pull the installer too, and goes on with the image built
  here.
- **npx.** `npx ai-dev-system@<version> setup` installs that version and moves the
  entries to it; 3.0.0 is the first version on npm.
- **The Windows installer.** Uninstall it; the updater does not install an older version.
