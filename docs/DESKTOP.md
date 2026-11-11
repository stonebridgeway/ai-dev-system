# The desktop app

A tray icon, a first-run wizard, a Status screen, the screens of your work — projects, costs,
skills, settings, the daemon's log — and a console for every tool, over the daemon every AI client
shares. The app is in `desktop/`, built on Electron (the version is pinned in
`desktop/package.json`). It does not run AI Dev itself: it drives the same daemon the clients'
`ai-dev mcp` reaches, through the control API
([CONTROL-API.md](../ai-dev-mcp-server/docs/CONTROL-API.md)).

On Windows and Linux the app comes as a package that brings everything it needs — see
[The desktop install](#the-desktop-install). macOS (Apple silicon) is in development: the app builds
and runs there, but 3.0 does not release it. To work on the app, it runs from a
checkout:

```bash
cd ai-dev-mcp-server && npm ci && cd ../desktop
npm ci
npm start
```

The Electron binary is fetched the first time it is needed (`npm run electron:install` fetches it
ahead of time).

## What it needs

- **Node.js 22.16 or newer (not 23).** The daemon runs on Node, and the daemon's build includes the
  Node it runs on: the app starts and reaches the daemon with the Node your AI clients use, or the
  clients and the app would each get a daemon of their own. It looks for Node in this order:
  `AI_DEV_NODE`; the Node the installed app ships, which the clients it connects run too; the
  Node an AI client's ai-dev entry runs (what `ai-dev clients install` wrote);
  `PATH`; where installers put it (`/opt/homebrew/bin`, `/usr/local/bin`, nvm, Volta,
  `Program Files\nodejs`). None found: the window says so, and **Try again** looks again — a Node
  installed since is found; one named in `AI_DEV_NODE` needs the app started again.
- **The server beside it**: `ai-dev-mcp-server/` next to `desktop/` in a checkout, or the folder
  `AI_DEV_SERVER_ROOT` names, with its packages installed (`npm ci` there); the installed app
  runs the server of the runtime it ships. The app's own variables
  (`AI_DEV_SERVER_ROOT`, `AI_DEV_DESKTOP_*`) do not split it from the clients: it reaches their daemon.

When something of this is missing — the server, its packages — or the settings file is broken, the
window says what, and what to do — in the system's language: fix the settings file or remove it,
then **Try again**; **Restart AI Dev** for the server, whose code is loaded once per run. A language
chosen on the broken-settings screen holds, and is written to the settings once the file can be
read — unless the fixed file names a language of its own, which then holds.

## What it shows

- **Connecting / not running.** When the daemon is not running and the setting `daemon_autostart`
  is on (the default), the app starts it, as a client's bridge does. With it off, or when the start
  fails, the window says the daemon is not running and has a **Start the daemon** button; a start
  that failed shows why, with the last lines of the daemon's log, and so does a daemon that stopped
  unexpectedly. Without a daemon the app looks for one every ten seconds without starting it: when
  an AI client starts the daemon, the app comes back online by itself.
- **The first-run wizard** opens by itself while the search index is not built, and from **Setup**
  at any time:
  1. **Projects folder** — chosen in the system's dialog and kept in the settings (`projects_root`).
  2. **AI clients** — the clients found on this computer, each with what its ai-dev entry runs now
     (nothing, AI Dev 2.x, another install, Docker, another program) and a box; a client already
     using another install, Docker or another program is not chosen for you — connecting replaces
     that entry — and one whose config cannot be read cannot be chosen. **Connect the chosen
     clients** writes their configs (`clients_install`), each backed up first, and says what
     happened to each, with the reason when one failed.
  3. **Local model** — **Download** with progress and **Cancel** (what was fetched is kept, and the
     next download continues from there), **Import from a folder…** — a copy from another computer
     or a USB stick — or **Skip for now**: search then works by words.
  4. **Search index** — builds the skill registry and the index (`setup_run`), with the model's
     vectors when the model is there, with progress; each step says what it did, and a failed one
     its error. The outcome stays with the step, with **Build again**.

  While a download or a build runs, **Back** and **Next** wait for it; a person who goes to Status
  and comes back finds it still running, with its **Cancel**, or what it came to.
  5. **AI Dev is ready** — what to do next, and the way to Status.
- **Status** — whether the install works, works with something to look at, or does not work yet, and
  why — the daemon's own summary and the settings file's problems; the model, the index and the
  clients at a glance; every health check with its verdict, its details and what to do about it, the
  failing ones first and the critical among them marked; **Refresh**, **Rebuild the index** — with
  its progress and **Cancel**, still there after a look elsewhere — and **Run setup again**. The
  three slow checks `system_status` does not run (search smoke, dense smoke, search eval) are left
  to `ai-dev doctor`.
- **Projects** — the projects AI Dev knows (registered with `register_project`, or by a task begun
  in them), and a project's card: its tasks with their criteria, its epics — how far each has come
  and the part to work on next —, its decisions, the handoffs sessions left for the next one, and
  the project card itself. The card shows the first 50 tasks and decisions, 20 handoffs and 10
  epics, and says when there are more. Returning to Projects opens the card you left.
- **Costs** — what the work has cost today, yesterday, in the last seven days and in all, by model,
  by tool and by task, for all projects or one (`usage_report`). A cost the client did not report
  is an estimate from the published prices; a retired model's price is not checked again.
- **Skills** — your own skills first: **Add a folder…** (one that holds a SKILL.md, chosen in the
  system's dialog), **New skill…** (a name and one sentence of what it does; the app writes the
  SKILL.md from a template, and you write its steps), **Import from GitHub…** (a repository of
  skills; by default only its `skills/<name>` folders that pass the import policy, read as reference
  data until reviewed), **Rebuild the registry**, and **Remove** beside each skill you added. A
  skill that came with AI Dev is never removed: the next update would put it back. Search and
  routing see a change at once. Below, the catalog by group, a search — its first 20 matches, saying
  when there are more — and a skill to read.
- **Rules** — one repository at a time, a project AI Dev knows or a folder you choose: its guard
  rules (`.ai-dev/policy.json`, what the agent hooks block or warn about) — added from a form and
  checked against a sample before they are saved, switched on and off, removed —; whether the agent
  hooks that enforce them are installed, and installing them (minimal, standard or strict); the
  engineering rules each assistant reads (`.ai-dev/rules`, `.claude/rules`, `.cursor/rules`,
  `AGENTS.md`), what would be written and writing them — a file you edited is kept; and the MCP
  servers its configs start, with what to check before trusting them (an unpinned package, a
  credential in cleartext), your own configs too when you tick the box.
- **Settings** — the projects folder, the tool profiles AI clients get, the model's download mirror,
  the model folder, the daemon's idle time and whether the app starts it: each with what it does,
  the value in force and where it comes from, and when a change applies — at once, to AI client
  sessions started afterwards, or when the daemon starts next. A change for new sessions reaches
  the app when it reconnects: **Reconnect now** opens a new session, and the daemon goes on. A value
  the daemon refuses is not written, and the daemon's reason is shown. The model's download mirror,
  the model folder and the profiles are saved only after you confirm the new values in the system's
  message box — they decide where the daemon downloads from, what it reads as the model and which
  tools AI clients get; Cancel saves nothing. The language is chosen in the header.
- **Log** — the daemon's log and its part set aside at 1 MB; **Follow** reads it again every two
  seconds while the screen is open.
- **Console** — every tool the daemon lists to the app, each marked *reads only*, *changes
  something* or *deletes*; a form built from the tool's input schema (text, choices, numbers within
  their bounds, flags, lists one per line, JSON for the rest), checked before it is sent; the answer
  readable — names and values, lists, Markdown — and as JSON, in the view you last chose while the
  app is open. Only the arguments the tool's schema names are sent. A tool that changes something
  runs only after you confirm it (see Security).

Every change the Skills and Rules screens make to your files — a skill added, a repository of
skills imported, a rule saved, the hooks or the engineering rules written — runs only after you
confirm it in the system's message box, which names the tool and what it is given; Cancel changes
nothing. Removing a skill or a rule goes through the tool console's confirmation, as every call
that takes back what it cannot undo does.

Every screen shows that it is loading, says why it is empty when it is, and shows an error with
**Try again**. Everything works from the keyboard — a skip link before the header, a visible focus
ring, each screen's heading taking the focus — and the colours meet WCAG AA in the light and the
dark scheme (a unit test checks the stylesheet).

## The app's session

The app reaches the daemon as a client of its own, named `ai-dev-desktop`, whose session lists
every tool an agent gets and the control API (`all,control`) — the screens read through the agent's
tools, and the console needs them all. The `profiles` setting is what AI clients get; it does not
narrow the app.

## The tray

The icon's colour is the install's state as the health checks give it — the same verdict as
Status: green — everything works, amber — something needs attention, red — it does not work yet,
grey — the daemon is not running. The checks run when the app connects, after anything it changes,
when what is on disk moves (looked at every thirty seconds) and every five minutes. Its menu: **Open
AI Dev**, **Rebuild search index** (with its progress, and when it fails, saying so), **Stop the
daemon** (every daemon of the AI Dev home; one that would not stop is said, with why, and **Stop**
is offered again for as long as it runs — the app's own, or another, such as an old daemon still
finishing a client's session), **Quit**. Closing the window keeps the app in the tray; **Quit** ends
it.

The daemon is not the app's: it goes on serving the clients after the app quits. While the app
runs, its session keeps the daemon from leaving on idle; after **Quit** the daemon leaves on its
own when nobody uses it. When the code is updated in place and a daemon of the new code takes over,
the app moves to it once the calls it has running end — the old daemon finishes them, a download
included; when none serves yet, it starts one only if it may start the daemon at all (autostart
on, or **Start the daemon** pressed). The old daemon leaves once its last session ends, an AI client's too.

## Languages

English and Russian. The language follows the system until you choose one in
the header, and the tray follows it. The choice is kept in the settings (`language`). While the file
cannot take it — broken, or held by another writer — it holds for the run and is written once the
file can: looked for twice a second, and once more at **Quit**, which waits for the file a second at
most. A choice made while the file could not be read gives way to a language the fixed file names
itself — the app cannot tell a line it wrote earlier from one you wrote — and the app then speaks
that language; a file a newer AI Dev wrote is left as it is. The app's own
words — screens, check and step names, states, advice — are in both; what the daemon writes — a
check's summary, a step's outcome, an error — is in English, as in the CLI.

## Security

The window shows only the app's own page and gives it nothing of Node or the file system:

- the page is served under `app://ai-dev` from `desktop/src/renderer` only — nothing outside it, no
  link out of it — with a Content Security Policy that allows the page's own scripts, styles and
  images and nothing else: no inline script, no `eval`, no network;
- the page runs isolated and sandboxed (`contextIsolation`, `sandbox`, no `nodeIntegration`; under
  Chromium's own sandbox too, but for an AppImage where user namespaces are refused, below) in a
  session of its own, kept in memory; its only way out is a frozen `window.aiDev` with twelve
  functions, each one channel of the main process;
- the main process answers those channels only from the app's page. The screens call only the tools
  named in `desktop/src/main/ipc-policy.mjs` — the control API's buttons and the read-only tools the
  data screens show — with only the arguments those screens send, checked by kind: not
  `model_remove`, `clients_remove`, an agent tool that changes something, a forced rebuild, a client
  the wizard does not offer;
- the tool console may call any tool the daemon lists to the app, but one the daemon does not mark
  read-only (`readOnlyHint`) runs only after you confirm it in the system's message box, which the
  main process shows: the tool, each argument on a line of its own — a character that would not show
  as itself (a line break, a direction mark) written as its code, a long value going on in indented
  rows and cut at 240 characters, a call that would need more than 36 rows refused — and Cancel as
  the default. The page can ask for a call; it cannot answer the box, skip it, add an argument the
  tool does not take, or call a tool read-only on its own word;
- the model's download mirror, the model folder and the tool profiles change from the page only
  after the same kind of confirmation (`CONFIRMED_SETTINGS`): with a mirror of its choosing, a page
  could have the daemon send anything it reads to another host in a download's address;
- arguments are plain JSON of at most 64 KB, and every call has an id of the page's own for its
  progress and cancel;
- the page cannot navigate away, open windows or `<webview>`s, ask for permissions or start
  downloads; every request to anything but `app://ai-dev` is cancelled, and WebRTC — which neither
  the policy nor the session's request handler sees — sends no UDP and goes over TCP only to a
  proxy that is not there;
- no host name is looked up for the page: Chromium's resolver in the app resolves nothing
  (`host-resolver-rules`), so neither a TURN server's name nor a `dns-prefetch` reaches DNS. The
  one exception is the installed app's updater: `github.com`, `objects.githubusercontent.com` and
  `release-assets.githubusercontent.com` resolve, by those exact names — no wildcard a page could
  put a word of its own into — and the updater's own session lets nothing but HTTPS to them
  through (`desktop/src/main/updates.mjs`). The daemon is reached from Node, over its socket. What remains: a `.local` candidate handed to WebRTC
  makes Chromium send a multicast DNS query to the local network — always for the fixed name
  `~NOTFOUND`, never for a name the page chose;
- there is no developer menu and no developer tools (`AI_DEV_DESKTOP_DEVTOOLS=1` opens them with the
  window, for working on the app).

The daemon's own protection — its socket, the secret in its descriptor, one user — is in
[SECURITY.md](../ai-dev-mcp-server/docs/SECURITY.md).

## The desktop install

The app is built for three systems, each as the packages people install there; each ships the app,
Electron, and in its `resources/runtime` the runtime AI clients run: the server with its
dependencies for that system and processor, and a Node of its own (Node 24 LTS, pinned by version
and sha256 in `desktop/build/node-<system>.json`).

| System | Package | Installs to |
| --- | --- | --- |
| Windows (x64) | `AI-Dev-Setup-<version>.exe` | `%LOCALAPPDATA%\Programs\ai-dev-desktop`, for the person running it — no administrator, with a Start menu and a desktop shortcut |
| macOS (Apple silicon), in development: not released | `AI-Dev-<version>-mac-arm64.dmg`, and a `.zip` of the same app, built from a clone | `/Applications/AI Dev.app`, dragged there from the `.dmg` |
| Linux (x64) | `AI-Dev-<version>-linux-amd64.deb`, or `AI-Dev-<version>-linux-x86_64.AppImage` | the `.deb` installs to `/opt/AI Dev`, with a menu entry and an AppArmor profile, by `sudo apt install ./AI-Dev-….deb`; an AppImage runs where it is (`chmod +x` it first), with FUSE 2 (`libfuse2t64` on Ubuntu 24.04) |

None needs Node, Python or Docker. The Mac app is in development: 3.0's release carries the Windows
and Linux packages only, and what follows about the Mac is how its build behaves today. A Mac with an
Intel processor has no package: onnxruntime-node,
which the local model runs on, ships no build for it — the npm package or Docker serve it, with
word search. A Mac app that is not signed with a Developer ID and notarized (the project's builds are
not, unless the owner adds a certificate) is refused the first time: on macOS 15 and later it is
opened once, then allowed with **System Settings → Privacy & Security → Open Anyway**; on macOS 14
and earlier with **Open** in the Finder's menu (right click on the app). macOS remembers the answer.

Chromium's sandbox needs unprivileged user namespaces, which Ubuntu 24.04 refuses by default to a
program without an AppArmor profile. The `.deb` installs one, and the sandbox stays. An AppImage
cannot: its `AppRun` (electron-builder's) tries `unshare -Ur true` and, where that is refused, starts
the app with `--no-sandbox`. The page it shows is the app's own, with no network, isolated from Node
(above), so that costs a second wall, not the first; where it matters, install the `.deb`.

### How AI clients reach it

No client runs anything in the app's own folder. Windows does not replace a file a running process
holds — the Node of every client's bridge, the daemon, the local model's DLLs — and its installer's
update moves the whole program folder aside before it writes the new one, so a single held file
would stop it ("File is busy, aborting"); an AppImage's files exist only while it runs, at a mount
point that changes each time; an update of the Mac app or the `.deb` replaces the folder. So the
runtime is copied into the AI Dev home, and the clients run the copy (Windows paths shown; on
macOS and Linux the same under `~/.ai-dev`, with `node/bin/node` and a symbolic link):

```text
%LOCALAPPDATA%\Programs\ai-dev-desktop\resources\runtime    what the installer ships (bundle.json lists every file)
        │  copied at the app's start, each file checked against its sha256
        ▼
%USERPROFILE%\.ai-dev\app\3.0.0-1a2b3c4d\                   one copy per runtime: server, dependencies, node\node.exe
        ▲
%USERPROFILE%\.ai-dev\app\current                           a junction to the copy in use — what every client config names:
                                                            current\node\node.exe  current\ai-dev-mcp-server\bin\ai-dev.mjs mcp
```

An update brings a new runtime: the app copies it beside the old one and moves the junction. A
client already running keeps the files it opened, in the old copy, and its daemon serves it until
it leaves; the next session a client starts runs the new copy. No running file is written over,
and no client config changes. Of the runtime copies the two chosen last stay, and any copy an AI
client's config names by its own folder; an older one is removed once nothing holds it. The copies
`npx … setup` makes beside them are counted apart, and an update of the app never removes one. A
junction needs neither an administrator nor Developer Mode; on a drive that cannot hold one —
`AI_DEV_HOME` on exFAT, FAT32 or some network shares — the copy runs as it is, the client configs
name the copy itself, and **Status** says so, with the reason the drive gave: after an update,
running setup again and connecting the clients (**Setup** → AI clients) points them at the new
copy; until then they keep the one they name.

On macOS and Linux the CLI for a terminal is `~/.ai-dev/app/current/ai-dev`, a shell script that
runs the runtime's own Node: `~/.ai-dev/app/current/ai-dev status`, or put
`~/.ai-dev/app/current` on your `PATH`. The daemon's hints name it in full, in single quotes when
the path holds a space. On Windows it is
`%USERPROFILE%\.ai-dev\app\current\ai-dev.cmd`. Nothing is put on
`PATH`, so it is run by its full path — in cmd `"%USERPROFILE%\.ai-dev\app\current\ai-dev.cmd"
doctor`, in PowerShell `& "$env:USERPROFILE\.ai-dev\app\current\ai-dev.cmd" doctor`. The
daemon's hints name it in full: as it is when the path holds only letters, digits and `_-.:\/`,
which both shells run, and otherwise in the PowerShell form, `& '…'`; in cmd, put such a path in
double quotes instead.

### The first start

The window says it is preparing AI Dev while the runtime is copied (the progress is shown; under
Wine it took 35 seconds; the Linux app, from its unpacked folder, a few seconds), then starts the
daemon on the runtime's Node. The daemon fills your vault, `~/.ai-dev/vault`, from the skill seed,
and the first-run wizard opens. A runtime that is not what the installer shipped — a file changed
or missing — is not run: the window says so, with **Try again**, and running the installer again is
the way back.

At every start the app checks its copy against `bundle.json`, file by file, by size, and puts back
from the program folder what went missing or changed — a DLL an antivirus took away, a file edited
by hand —; **Status** says which files. One a running AI client holds cannot be put back: the
window says so — close the AI clients and **Try again**. A change that keeps a file's size is not
seen: hashing the whole runtime at every start would take seconds.

### Updates

The installed app looks for an update a minute after it starts and every six hours, in the GitHub
Releases of the production repository, `stonebridgeway/ai-dev-system`, downloads
it in the background, and offers **Restart to update to …** in the tray; one not taken is installed
at **Quit**. A signed build checks the download against the signature of the app that runs; an
unsigned one against the sha512 the release lists. `AI_DEV_DESKTOP_UPDATES=0` turns the checks off.

That is the Windows app and the AppImage, which replaces its own file. The `.deb` is updated by
installing the new one (`sudo apt install ./AI-Dev-….deb`). A Mac app updates itself only when it
is signed with a Developer ID; otherwise the new `.dmg` replaces it — drag the new app over the old
one. Either way the next start copies the new runtime and moves the link.

### Uninstalling

On Windows, **Settings → Apps → Installed apps → AI Dev → Uninstall** asks, after its "Are you sure?", two
questions before it removes the program:

1. whether to take AI Dev out of the AI clients' settings — **Yes** by default: their entries run the
   program that is going. An entry of another install (a clone, npx, Docker) stays;
2. whether to delete AI Dev's own data, `%USERPROFILE%\.ai-dev` or the folder `AI_DEV_HOME` names —
   the vault it keeps, the tasks and session history, the local model, the search index, the
   backups, the settings — **No** by default. Your projects are not touched. The folder is deleted
   only when what it holds is AI Dev's own — at its top, and inside its `models`, `cache` and
   `backups` folders, which a person might name the same; one that holds anything else as well —
   `AI_DEV_HOME` set to a folder you keep other files in — is kept whole, and the uninstaller says
   so. Nor is it deleted while a runtime copy is in use: **Retry**, below, deletes it once the
   clients are closed.

It then runs `ai-dev uninstall` from the runtime it ships: the daemon is stopped, the runtime
copies and the junction are removed, and the answers are carried out. A file an AI client still
runs cannot be removed: the uninstaller asks you to close your AI clients and **Retry** — or
**Cancel**, which leaves those files in `%USERPROFILE%\.ai-dev\app` for you to delete later. A
silent uninstall (`/S`) asks nothing and takes the default answers; an update runs none of this.

`ai-dev uninstall` itself tells its caller by the exit status: 0 done, 1 something failed, 3
something is in use (close the AI clients and run it again), 4 the data was kept.

On macOS and Linux nothing runs when the app is removed, so run it yourself first — it says what it
would do, and does it with `--yes`:

```bash
~/.ai-dev/app/current/ai-dev uninstall --clients --yes          # the runtime copies, the link, the clients' entries
~/.ai-dev/app/current/ai-dev uninstall --clients --data --yes   # and AI Dev's own data in ~/.ai-dev
```

Then move the app to the Trash, delete the AppImage, or `sudo apt remove ai-dev-desktop`.

### Building it

```bash
cd ai-dev-mcp-server && npm ci && cd ../desktop
npm ci
npm run dist:win      # or dist:mac on a Mac, dist:linux on Linux
```

Each builds `dist/<target>/installer/` (`dist/windows/` for Windows): `AI-Dev-Setup-<version>.exe`;
the `.dmg` and the `.zip`; the AppImage and the `.deb` — with their `.blockmap` and the
`latest*.yml` the updater reads from a release — and `build-report.json` beside it, the runtime's
composition. The target is the machine's own unless `--target win32-x64|darwin-arm64|linux-x64`
names another (`node scripts/build-desktop.mjs --target …`): the runtime's dependencies are fetched
for the target (`npm ci --os --cpu`), but a `.dmg` is made on macOS only, and on Linux and macOS
the Windows installer needs Wine — 32-bit too — to make its uninstaller. `--dir` builds only the
unpacked app; `--check` stops before electron-builder, at the runtime checked for what it must and
must not hold, at its `bundle.json` read back by the app's own parser, and at the app's version,
which must be the runtime's — the updater compares the app's version with a release's. The CI job
`desktop` runs the check for Windows and Linux; `.github/workflows/desktop-windows.yml` builds the
installer on `windows-latest`, and `.github/workflows/desktop-macos-linux.yml` the Mac and Linux
packages on `macos-latest` and `ubuntu-latest`, then runs each shipped runtime as an AI client
does and starts the built app (`test/e2e/packaged.test.mjs`).

The runtime is the npm package's distribution (`npm run dist`) with its dependencies for
the target, less what never loads there: onnxruntime-web (transformers carries the web runtime
inside its own file), the WebAssembly build of sharp and what only it needs, sharp's and
onnxruntime-node's builds for other systems and processors (on Linux the musl ones too), npm's
command links. Measured on version 2.0.0 for Windows: 7,847 files, 231 MB unpacked — Node 89.7 MB,
onnxruntime-node 64 MB, the seed 21 MB, sharp 18.5 MB; the installer 183 MB. Version 3.0.0 for
Linux: the AppImage 218 MB, the `.deb` 167 MB.

Signing comes from the environment. Windows: a certificate in `WIN_CSC_LINK` (or `CSC_LINK`) with
its password in `WIN_CSC_KEY_PASSWORD`, which electron-builder reads itself, or Azure Trusted Signing
named by `AI_DEV_SIGN_AZURE_ENDPOINT`, `AI_DEV_SIGN_AZURE_ACCOUNT`, `AI_DEV_SIGN_AZURE_PROFILE`
and `AI_DEV_SIGN_PUBLISHER`, with the `AZURE_*` credentials. The four go together, or the build
stops: `AI_DEV_SIGN_PUBLISHER` is the signing certificate's name, which electron-updater checks
every update against — a wrong one would refuse every update. Without either the installer is
unsigned, and Windows SmartScreen warns about it on first run. macOS: a Developer ID Application
certificate in `CSC_LINK` with `CSC_KEY_PASSWORD` signs the app with the hardened runtime, and
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` send it for notarization, a path not
finished yet (the runtime's native modules are not signed with the Developer ID); without one the app
is signed ad hoc — Apple silicon runs nothing unsigned — and does not update itself. The Linux
packages are not signed.

## Tests

```bash
cd desktop
npm test          # unit tests, then the app end to end
npm run test:unit # unit tests only
```

The end-to-end tests launch the app through Playwright's Electron driver on a real daemon, each in
an install of its own (home, vault, runtime home, the synthetic model on a local host): the wizard
to the end and a build run again, a download cancelled midway and the state it leaves, the screen
without a daemon and its Start button, the screen without Node and its Try again, a broken settings
file — in Russian too — and a server without its packages, Restart, a second launch that tries a
failed start again, a daemon that dies and one a client starts again, a second launch, Status with
its checks, Russian, the tray's verdict with a failing critical check, an AI client joining the
app's daemon, a daemon replaced by a newer one, a daemon that will not stop — the app's own and
another build's —, a language chosen while the settings file is broken or held by another writer,
Quit with one waiting, the Windows install's runtime — copied and run through its link, the
seed filling the vault on the first start, a client connected through the link, an update while
that client keeps running, a damaged runtime refused, a copy that lost files put back at the
next start, and — as root, where a folder made immutable refuses the link as a FAT drive does —
the app without its link, its clients connected to the copy —, and what the page cannot reach — WebRTC and the names it would look up,
another page with the app's functions, the developer tools; the data screens with work an AI client
made (a project with an epic, a decision, a handoff, usage), in English and Russian, and empty on a
fresh install; Settings — a refused value, a change for new sessions and the reconnect; the console
— a read-only tool at once, one that changes something cancelled and then confirmed, the page
calling the console directly; your own skills — one from the template, one from a folder, one not
confirmed and so not written, one removed through the console —; the Rules screen — a guard rule
added, one refused by its own sample, one switched off and removed, the hooks installed, the
engineering rules previewed, the MCP servers of a repository with their finding —; the keyboard;
a daemon stopped while a screen polls it. With `AI_DEV_DESKTOP_PACKAGED` naming a built app's
executable, `test/e2e/packaged.test.mjs` starts it as installed and checks that it copied its
runtime, linked it, and runs its daemon on the shipped Node. On a Linux
machine without a display they run under `xvfb-run`; screenshots go to `desktop/test-results/`.
Where Chromium cannot have its own sandbox (as root, or `AI_DEV_DESKTOP_NO_SANDBOX=1` on a CI
runner that forbids user namespaces) it runs without it; the page keeps its sandbox flag.
