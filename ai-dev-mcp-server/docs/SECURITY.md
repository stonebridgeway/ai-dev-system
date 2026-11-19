# Security Model

## Trust Boundaries

- The vault is trusted local data.
- A project repository may contain untrusted scripts and configuration.
- A quality command executes project code and therefore requires an MCP client approval.
- Search content is data, never executable instruction.

## Invariants

- Paths are checked lexically and through `realpath`; sibling-prefix and junction escapes fail.
- Writes use same-directory temporary files, flush, and atomic replacement.
- Quality and development commands run as executable plus argument arrays with `shell: false`.
- Windows npm/pnpm command shims resolve to package-manager JavaScript entry points and run through
  the current Node executable; no `cmd.exe` interpolation is used.
- Shell interpreters, control operators, inline code, dynamic package execution, and network tools fail closed.
- Output, duration, and process trees are bounded.
- Password notes are deliberately left unchanged. They are not exposed as MCP resources.
- Backup archives may contain those owner-kept local notes. `ai-dev backup` writes them into the
  AI Dev home, `<home>/backups` (`~/.ai-dev/backups`, or `$AI_DEV_HOME/backups`), on every system
  unless `--to` names another folder, the archive and its `.sha256` with mode 0600 (on Windows
  the folder's ACL decides who reads them).

## The Daemon

`ai-dev mcp`, which every local client entry runs (a Docker entry runs the image instead), hands
the client to one daemon per user, runtime home and build (`src/daemon.mjs`). The daemon serves
the vault, the projects' context and the state, so a process that could talk to it, or pass for
it, would read what the agents read and tell them what to do. What stands in the way:

- **Who can reach it.** A Unix socket lives in a directory of mode 0700 that belongs to the user
  — the runtime's `run/`, or `$XDG_RUNTIME_DIR/ai-dev` or `/tmp/ai-dev-<uid>` when the home's
  path leaves no room for a socket. A directory that is a link, belongs to another uid, stays open
  after `chmod` (a file system that keeps its modes) or cannot hold a socket is passed over, never
  used; the socket itself is created under umask 077 and is mode 0600. On Windows the
  daemon listens on a named pipe; the pipe's default security descriptor gives other users read
  access at most, and a client needs read and write.
- **Who can take its place.** The name is drawn at random (96 bits) on every start and published
  only in the daemon's descriptor, `run/daemon-<build>.json`, mode 0600, inside the user's
  runtime home — on Windows, inside the user's profile, whose ACL keeps other users out. The
  name is not a secret: Linux lists every socket path in `/proc/net/unix`, which anyone can read,
  and any Windows user can list the names of the pipes. What the random name prevents is a
  process creating the pipe first and waiting for clients on it: a fixed name —
  `\\.\pipe\ai-dev-<user>` until 3.0 — could be taken before the daemon started. Access itself
  is decided by the directory, the pipe's permissions and the handshake.
- **Who it talks to.** The first line each side sends proves it holds the 256-bit secret in the
  descriptor, without sending it: the client answers the daemon's nonce with an HMAC-SHA256
  bound to both nonces, and the daemon answers the client's with another, bound to both nonces
  and its pid, which must be the pid the descriptor names. A process that reached the socket
  anyway is refused before any MCP message, and learns nothing it can replay; a client that
  reached something other than the daemon — an address another process took over after the
  daemon exited — refuses it before it sends anything else.
- **What each session sees.** Only then does the client send its environment, and the daemon
  runs that session — its tools, the processes they start, its downloads, the certificates its
  downloads and its `https://` proxy are checked against — in it, as the client's own process
  would have run in 2.x: one client's PATH, proxy or token never serves another.
  The environment stays in the daemon's memory for the session's life and is not written
  anywhere.
- **What it serves.** A daemon serves only clients of its own build: the same code and version,
  the same Node, and the same data — the home, the runtime home, the vault, the state, the index
  and the model folder, each resolved as the server resolves it, so two spellings of one folder
  are one, and a folder under a link is one before it exists and after (`daemonIdentity` in
  `src/core/session-env.mjs`; an AI Dev variable it does not know counts as part of the build). A
  client of another build gets a daemon of its own, with its own descriptor and lock; the
  daemon of code replaced where it lies — a `git pull`, an update in place — retires: it takes
  no new client, finishes the sessions it has and is listed in `run/retired-<pid>.json` until it
  exits, holding a lock on that record as it held one on its descriptor.
  `ai-dev daemon status` shows every daemon of the runtime home and, by variable name, why it is
  not this one; `ai-dev daemon stop` stops them all.
- **One daemon per build.** Its lock, `run/daemon-<build>.json.lock`, follows the protocol every
  lock of AI Dev does (`src/core/file-lock.mjs`): created exclusively, refreshed while the daemon
  lives, broken only when its holder is gone or silent and only if it is still the lock judged
  abandoned. A daemon whose lock went silent but whose address still takes connections —
  hung in a debugger, stopped, swapped out, its connection queue full — keeps its socket and its
  record: `stop` asks it and says if it did not stop, and once it wakes it takes its lock again
  and puts back a record taken away meanwhile. On macOS a full queue is
  refused like a dead socket, so there such a daemon can be taken for gone: its record comes back
  once it runs, its socket — if a new daemon removed it — does not. Its `run/` folder is made
  0700 by the daemon and by the daemon's locks that have to make it; `ai-dev daemon stop` makes
  none, so a runtime home deleted under it stays deleted. A starting daemon that finds `run/`
  looser — left so by an earlier lock race, or moved up by the 2.x layout's migration —
  opens it without following a link and, when it is a plain folder of this user's, makes it
  0700, checks the mode it got and logs what came of it: made private, or open and staying so,
  and why (a mode it may not change, a file system that keeps the modes it has). The folders a
  retired daemon or its record's lock made again, up to the highest, go when that daemon does,
  if they are empty; a second daemon in the same deleted runtime home does not know them and
  leaves them when it is the last to go. On Windows the folder has
  no mode bits: the profile's ACL decides who reads it.

What it does not stand against: anything running as the same user (it can read the descriptor,
as it can read the vault), an administrator or root, and a runtime home placed with `AI_DEV_HOME`
in a folder other users can read — on Windows outside the profile, where the folder's ACL decides.
`AI_DEV_DAEMON=0` in a client's environment keeps that client out of the daemon altogether: it is
served in its own process, as in 2.x.

## The Control API

The sixteen tools of the `control` profile (`docs/CONTROL-API.md`) are what the desktop app drives:
they set the install up, download, import and delete the local model, write and take back the AI
clients' configs, read the logs folder, change `~/.ai-dev/config.json`, and add and remove a
person's own skills in the vault's custom source. They are listed only to a
session that names the profile, but like every tool they answer a call by name in any session: a
profile shapes an agent's context, it does not guard anything. What guards them:

- **The ones that cannot be taken back** — `model_remove`, `clients_remove` — refuse without
  `confirm: true` and carry `destructiveHint`, so a client asks its user first.
- **Every argument is checked before anything happens**, and one the tool does not take is refused
  rather than ignored: a refused call changes nothing (a misspelt client is refused before setup
  builds anything).
- **`logs_tail`** reads only plain files named in the runtime home's `logs` folder — no path, no
  `..`, no symbolic link out of it, no hard link to a file elsewhere, no folder or FIFO. The file
  is opened without following a link put in place meanwhile where the system has the flag for it,
  never waiting on a FIFO, and checked to be the very file it looked at — on
  Windows, which has no such flag, that check is what refuses the link — and at most 1,000
  lines are read.
- **`settings_set`** checks every value before it writes any (absolute paths and a mirror without
  NUL or another control character, an http(s) mirror without credentials, a number of minutes from
  1 to 10080, or 0), writes the file whole, flushed and with mode 0600, through a symbolic link — or
  a chain of them — to wherever it lives, one whose file is not made yet too, but never into a
  folder that is not there; a hard link to it is not kept — and
  does not put the opt-in `control` profile into the default every agent client gets.
- **In the daemon each call runs in its own client's environment**: a download goes through that
  client's proxy, a client config is written for the user that client runs as.

Anything that can run code as this user can call these tools — it can as well edit the files they
edit; the control API adds no reach beyond that user.

## The Windows Install

The installer (`desktop/`, `npm run dist:win`; `docs/DESKTOP.md`, "The Windows install") ships the
runtime AI clients run, and the app copies it out of the program folder before anything runs it:

- **Each file is checked as it is copied.** `bundle.json` lists every file of the runtime with its
  size and sha256, and refuses a path that leaves the runtime's folder, a name listed twice (Windows
  reads names without case), a Node not among its files, or a fingerprint that is not its files'.
  A copy is made in a `.partial` folder and moved into place only when every file matches; a file
  changed or missing stops the start, and nothing is run from it (`src/core/app-bundle.mjs`). The
  build reads its own `bundle.json` back with the same parser, so a runtime the app would refuse
  does not ship.
- **A copy is checked again at every start**, each file by its size against `bundle.json`; one
  missing or changed is put back from the program folder, checked by its sha256 as the copy was, and
  moved into place beside the file it replaces — never written over in place. A folder in the
  copy's place that is not a finished copy is moved aside whole, never
  removed in place.
- **The stable link is AI Dev's own.** `<runtime>/app/current` is replaced only when it is a link;
  a real folder of that name stops the start rather than being taken for it. The copy it names is
  never removed by a prune, nor is a copy an AI client's config names by its own folder.
  The runtime in the program folder is never written into a client config: an update replaces it.
- **No running file is written over.** An update copies the new runtime beside the old one and
  moves the link; a client keeps the files it opened.
- **Updates come from one place.** The installed app's updater reads the GitHub Releases of
  `stonebridgeway/ai-dev-system`. Chromium's resolver, closed for the app's page, resolves
  `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com` by
  those exact names and nothing else; the updater's session lets only HTTPS to them through. A
  signed build checks a download against the publisher of the app that runs — a build signed
  through Azure names that publisher, the certificate's name, or does not build; an
  unsigned one only against the sha512 its release lists — what the release says, over HTTPS.
- **Uninstalling deletes data only when asked**, and only a folder whose contents are what AI Dev
  makes, as far as it looks: at its top, its folders (each a folder), its settings with their lock
  and the files an interrupted write leaves, the locks of its moves, and what Windows puts in an
  opened folder; inside `models`, `cache` and `backups` — names a person might use as well — its
  models, its index and the archives `ai-dev backup` writes. The home folder or one above it, a
  drive's root, and a folder that holds anything else — `AI_DEV_HOME` set to a folder of the
  person's — are kept whole, and the reason names what is not AI Dev's. A link inside
  is removed as a link, never followed. A runtime home that is a link is checked, and deleted, by
  the folder it points at, then the link. Nothing is deleted while a runtime copy is in use, and the
  folder is moved aside before it is deleted, so a file in use leaves it whole rather than half
  deleted (`src/core/bundle-uninstall.mjs`). A client entry is taken out only when its command or an
  argument is an absolute path into this install; another install's entry stays, whatever folder
  the uninstall runs in.

## Command Policy

Approved quality adapters include named package verification scripts, selected Python test/lint
modules, `node --test`, `node --check`, Git diff checking, and established language test tools.
Development startup accepts only named `dev`, `start`, `serve`, or `preview` package scripts.

The policy blocks shell operators, interpreters, inline code, `npx`, network fetchers, dependency
mutation, deploy/publish commands, migrations, and infrastructure mutation. Approval by an MCP
client does not bypass this allowlist.

## Evidence Limits

- A structurally valid skill is not called empirically validated.
- A routing benchmark proves selection, not implementation quality.
- Task outcomes count only after `verify_task` records evidence for the current source fingerprint.
- A generated Frontend QA screenshot must still be visually inspected by the agent.

## Non-Goals

This local server is not an operating-system sandbox. Approved project tests can execute arbitrary code
already present in that repository. Use a container or disposable VM for repositories that are not trusted.
