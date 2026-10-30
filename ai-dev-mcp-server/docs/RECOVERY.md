# Backup And Recovery

## Backups

```bash
ai-dev backup before-change            # from a clone: npm run ai-dev -- backup before-change
```

`ai-dev backup [label] [--to <folder>]` writes `ai-dev-system_<UTC time>_<label>.zip` and a
`.sha256` beside it into `--to`, by default `~/.ai-dev/backups` (`$AI_DEV_HOME/backups` when
`AI_DEV_HOME` is set). It runs on every system and in every layout — a clone, a full vault, an
installed package — and holds two things:

- `vault/` — the content this install reads and writes: the Obsidian vault, a package's
  `~/.ai-dev/vault`, or a clone's `docker/public-seed`;
- `runtime/state/` — AI Dev's state: tasks, sessions, the usage ledger, instincts, skill
  outcomes, the record of client configs — from `AI_DEV_STATE_ROOT` when that moves it.

`BACKUP-MANIFEST.json` inside lists every file with its size, sha256 and permissions. Indexes,
caches, dependencies and VCS folders are left out — `ai-dev setup` rebuilds the indexes — except
the vendored tree a skill runs from (Archify's), which nothing reinstalls. Nothing else of the
AI Dev home is in the archive either: not the local model — `ai-dev setup` puts it back only
when asked, with `--model` or a yes to its question at a terminal, and `ai-dev model import`
copies it from another machine — and not your settings, `config.json`: copy that file yourself
if you changed any. Links are not followed and are listed as left out. The archive holds your
notes: keep it private.

2.x had a PowerShell script for this that worked only inside a full vault
; `scripts/backup-ai-dev-system.ps1` is now a wrapper over this command
until 4.0.

## Restoring

```bash
ai-dev restore <archive.zip> --confirm                 # back where it came from
ai-dev restore <archive.zip> --confirm --to <folder>   # laid out under a folder of your choice
```

Without `--to`, `vault/` goes back into the vault this install reads and `runtime/state/` into
AI Dev's state folder. Before anything is written:

- the archive is checked against its `.sha256`, when it is there;
- every file that would be written over is counted, and the restore stops unless `--overwrite`
  says to replace them — nothing is half-restored;
- every name is checked to stay inside the folder it lands in.

It is all or nothing: every file is unpacked beside where it goes and checked against its
sha256 before the first one is put in place, a file it replaces is set aside until all are in,
and a failure on the way puts the set-aside ones back. Permissions come back as they were.

An archive the 2.x script made holds a whole vault and has no per-file sums; it needs `--to`.
`scripts/restore-ai-dev-system.ps1` is a wrapper over this command until 4.0.

## Recovery Order

1. Quit the AI clients and the desktop app, then stop the daemon with `ai-dev daemon stop`, so
   no server is writing. The daemon outlives its last client by its idle time (30 minutes by
   default), and a client still running would start a new one.
2. `ai-dev restore <archive.zip> --confirm` (with `--overwrite` over an existing install), and
   put back `config.json` if you kept a copy.
3. From a clone, restore the dependencies: `npm ci` in `ai-dev-mcp-server/`, and
   `ai-dev setup --frontend-qa` for Frontend QA's. A package has them already.
4. `ai-dev setup` rebuilds the skill registry and the search index from the restored notes,
   and runs the health check; with `--model` it also installs the local model when it is
   missing and embeds the documents.
5. `ai-dev clients install` if the install moved; then restart the clients.

Do not restore cache databases over newer knowledge: rebuild them from the notes instead.

## Safe Restore Test

Restore into a new, empty folder first:

```bash
ai-dev restore <archive.zip> --confirm --to <empty-test-folder>
```

and compare what came out before restoring over the live vault.
