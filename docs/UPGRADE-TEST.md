# Upgrade test

An install of the 2.x line has to keep working after an upgrade — `git pull`, `docker pull`
or a reinstall — or migrate itself without losing data. `npm run upgrade:test` checks that for
a clone; `npm run docker:upgrade-check` does it for a Docker volume and the 2.x launchers.

## `npm run upgrade:test`

```bash
cd ai-dev-mcp-server
npm run upgrade:test                 # base: 86aba56, production main when 3.0 started
npm run upgrade:test -- --base <commit> --keep
```

It needs Node 22.16+ (on an older Node the checks of the Node search engine are left out), git,
Python 3 (the 2.x side runs on it; the upgraded side does not need it) and about two minutes. In a
scratch directory it:

1. checks the base commit out as a git worktree and installs it the way 2.x documented,
   `npm ci --ignore-scripts`;
2. creates the state five users have, each with its own home directory:
   - **default** — no `AI_DEV_HOME`;
   - **AI_DEV_HOME** — set to a folder of its own, where 2.x wrote everything one level too
     deep, into `$AI_DEV_HOME/.ai-dev`;
   - **Docker volume layout** — the environment `docker/Dockerfile` sets: `AI_DEV_HOME` under
     the home plus explicit state, index and artifact roots, run without a container;
   - **Python dense backend** — a client configuration with `AI_DEV_DENSE_BACKEND=python` and
     `BGE_M3_PYTHON`, the torch weights 2.x downloaded in `~/.ai-dev/models/bge-m3`, and vectors
     labelled with the Python backend's provenance (3.0 removed that backend);
   - **Codex runtime** — `~/.codex/state/ai-dev-system` and the index folder under
     `~/.codex/cache/ai-dev-system`, which 2.x used whenever they existed and `~/.ai-dev`'s did
     not — while the hooks always wrote to `~/.ai-dev/state`;

   and for each: a task with a checkpoint, a decision, an instinct, a session handoff, the
   search index with dense vectors — written by the 2.x helper as its ONNX path writes them,
   from synthetic numbers — Claude hooks in a git repository, and client configurations written
   by both 2.x installers (local and Docker);
3. upgrades the same checkout to the working tree in front of it, as `git pull` would, and runs
   plain `npm ci`;
4. starts the server through the command the 2.x client configuration holds and checks that
   the task, its checkpoint, the decision, the instinct and the handoff are found; that the
   Node search engine reads the 2.x index as it is — a status call rewrites nothing and leaves
   every vector untouched — and sees what the pull changed: skills the pull removed (the
   catalogue curation of 2026-10-11 removed 2,614 connectors) leave the skill registry and are
   no longer found; that a rebuild keeps byte for byte every vector whose
   document is still there unchanged and drops those of documents gone or rewritten — among them
   Membrane's connectors, which older 2.x releases embedded — leaving the rewritten
   ones to the next embedding run; that keyword and hybrid search answer, that nothing is left in
   `$AI_DEV_HOME/.ai-dev`, and that the 2.x hook still runs — and, where its copy of the old
   path cannot see the migrated task, sees it after `install_agent_hooks`; that the hook
   command `install_agent_hooks` writes now (`/bin/sh .ai-dev/hooks/with-node.sh …`) runs with a
   PATH holding git and nothing else; and that `npm run
   clients:install` moves the client configurations both 2.x installers wrote to 3.0 —
   `ai-dev-system` removed, the Docker `ai-dev` replaced, all six clients written with a backup,
   every written command answering `initialize` with instructions, a second run changing
   nothing. For the Python dense
   backend user it also checks that `embedding_status` names each leftover setting with the one
   command that replaces it, that the health check warns instead of failing, that hybrid search
   answers without comparing the Python vectors with anything, and that the one command the
   notes give — `npm run setup -- --model`, with a synthetic model standing in for BGE-M3 on a
   local mirror where huggingface.co would be — gives every eligible document a vector of the
   new model while the index stays whole. For the Codex runtime user it checks that nothing of
   AI Dev's is left in `~/.codex/state/ai-dev-system`, that the task now lives in
   `~/.ai-dev/state`, that the move is recorded in `state/runtime-home-migration.json` with where
   it came from, and that the 2.x hook — which never looked in `~/.codex` — now sees the task.

Each check prints `✓` or `✗`; the last line is `N of M checks passed`, and any `✗` makes the
exit code 1.

## The container half: `npm run docker:upgrade-check`

```bash
cd ai-dev-mcp-server
npm run docker:upgrade-check -- --old-image ghcr.io/stonebridgeway/ai-dev-system:2 --new-image ai-dev-system:local
```

`:2` exists once 3.0 is released — 2.x's `:latest`, copied to it before the 3.0 tag. Until then
the 2.x image is `ghcr.io/stonebridgeway/ai-dev-system:latest` itself: name it so, here and in the
commands below. It is then bootstrap's default installer as well, so `bootstrap.sh --image` needs
the 3.0 image you built to write the entries: `AI_DEV_INSTALLER_IMAGE=ai-dev-system:local`.
bootstrap tries to pull that one too, so Docker's "pull access denied for ai-dev-system …" is
expected, and the image built here is used.

It needs Docker, the two images and this clone with the base commit in it (`86aba56`; a shallow
clone fetches it with `git fetch origin 86aba56f9d2b7ebd6e883f4774778bd0625e17e3`): the 2.x
launcher is read from there. `docker-publish.yml` runs it on every pull request against the
production image — `:2`, or `:latest` until `:2` exists. On a
scratch volume and a scratch folder, both removed at the end:

1. **2.x fills the volume.** The 2.x image, started through the 2.x `docker/run-mcp.sh` as 2.x
   client configs start it, fills a new volume (its `cp -n` of the seed) and begins a task; a seed
   skill is then edited the way a user would, and a skill of the user's own is added.
2. **The new image under the 2.x launcher.** The same launcher (its cold path) with the new
   image: the server answers the handshake with its own instructions; the task is there; the
   volume's skills are the new seed's plus the user's own — what 2.x shipped and 3.0 dropped is
   gone, and the edited skill keeps the edit with `SKILL.md.seed-new` beside it.
3. **The 2.x warm path.** A runtime container of the new image, as the 2.x bootstrap started it,
   still serves a session through the 2.x launcher; the 3.0 script of the same name passes the
   server's own handshake through and says on stderr that it is the 2.x launcher.
4. **A 3.0 entry** on the same volume, with a host state folder mounted: the volume's state, the
   task with it, moves there.
5. **The way back as `bootstrap.sh --image …:2` writes it**: the 2.x image under a 3.0 entry
   answers and sees the task in that state folder.
6. **Back on the new image**: what that 2.x start's `cp -n` put back into the volume is removed
   again, and the volume has the seed's skills plus the user's own.

It prints the timings and counts as JSON and exits 1 at the first check that fails.

**Rolling back** to the 2.x image after step 4 through 2.x's own launchers (`AI_DEV_IMAGE`) finds
the vault, the index and the model, but not the tasks: they are in the host's state folder now,
where a 2.x launcher does not point the server. A 3.0 entry that runs the 2.x image —
`bootstrap.sh --image …:2` — hands it that folder, and it sees them there.
Nothing is lost; copied back into the volume, 2.x has them again under its own launchers too:

```bash
docker run --rm --entrypoint sh \
  --mount type=volume,source=ai-dev-system-data,target=/data \
  --mount type=bind,source="$HOME/.ai-dev/state",target=/host-state,readonly \
  ghcr.io/stonebridgeway/ai-dev-system:2 -c 'cp -a /host-state/. /data/runtime-home/.ai-dev/state/'
```

Returning to 3.0 undoes what the rollback did to the volume: 2.x's `cp -n` put back every skill
3.0 had dropped, its manifest with them, and the next 3.0 start finds that manifest, recognises
what came back by the seed history and removes it again; the tasks 2.x
began meanwhile move into the host's state folder.

The data half without Docker — the server with the image's environment on data 2.x wrote — is
the **Docker volume layout** scenario of `npm run upgrade:test`.

A clone rolled back to 2.x with `AI_DEV_HOME` set looks one level too deep again and finds
neither the tasks nor the index; nothing is lost, and setting
`AI_DEV_STATE_ROOT=$AI_DEV_HOME/state` and `AI_DEV_SEARCH_INDEX_DIR=$AI_DEV_HOME/cache/search-index`
for 2.x points it back at them. Measured on the trees `npm run upgrade:test -- --keep` leaves:
the 2.x server finds the task and 3,444 indexed documents in the Docker layout as it is, none
in the `AI_DEV_HOME` clone as it is, and both there with the two variables set.
