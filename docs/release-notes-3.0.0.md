# AI Dev System 3.0.0

3.0 changes how AI Dev is installed and how an AI client reaches it — not what an agent can do with
it. The server is the one 2.x users know: 135 tools, the vault and the task state in the same format,
the search index read without a rebuild. What is new is the way in.

## Install

- **Windows:** `AI-Dev-Setup-3.0.0.exe` below — for the current user, no administrator, nothing else
  to install first. The app updates itself from these releases.
- **Linux:** the AppImage below, which updates itself from these releases, or the `.deb`.
- **Windows or Linux with Node 22.16+:** `npx ai-dev-system setup`
- **Docker:** `sh ./bootstrap.sh` (Linux) or `.\bootstrap.ps1` (Windows) from the repository —
  [Install](https://github.com/stonebridgeway/ai-dev-system/blob/main/docs/INSTALL.md) has the details.

Each one finds the AI clients on the machine — Claude Code, Claude Desktop, Cursor, VS Code, Codex and
Gemini CLI — and connects them.

**macOS is in development.** 3.0 has no Mac app, and the terminal and Docker installs are not supported
on a Mac yet: the code is in the repository and CI tests it there, but it has not been accepted on a Mac.

## What is new

- **No Python.** Search, its index and hybrid ranking run in Node; the local BGE-M3 model is an ONNX
  export, downloaded with progress and resume and checked file by file (`ai-dev model install`).
- **One daemon for every client:** the index and the model are loaded once — three clients took
  528 MB, and take 391 MB.
- **One command line, `ai-dev`:** `setup`, `clients`, `model`, `daemon`, `doctor`, `backup`,
  `restore`, `uninstall`.
- **A desktop app** for Windows and Linux, in English and Russian: health in the tray, a first-run
  wizard, the projects, costs, skills and log, a console for every tool, settings.
- **Docker as a server mode:** each session is its own container — 1.6–2.5 s on a new volume, about a
  second after it; the image is 716 MB (2.x: 1.84 GB), with a `-browser` variant for Frontend QA.
- **614 skills instead of 3,228** — the integration connectors cut to the ones developers use;
  routing and search quality unchanged.

## Before you upgrade from 2.x

Read [Moving from 2.x to 3.0](https://github.com/stonebridgeway/ai-dev-system/blob/main/docs/MIGRATION.md): what changes for a clone, a Docker install and
Windows, what moves by itself, and what needs one command. In short:

- the licence: 3.0 is under the [PolyForm Noncommercial License 1.0.0](https://github.com/stonebridgeway/ai-dev-system/blob/main/LICENSE),
  © 2026 stonebridgeway — free for personal and noncommercial use; commercial use needs a licence from
  the author, [Telegram @stonebridgeway](https://t.me/stonebridgeway). 2.x stays under MIT;
- the client entry is `ai-dev` (the 2.x `ai-dev-system` entry keeps working until 4.0);
- Node 22.16 or newer;
- the Python dense backend is gone: `npx ai-dev-system setup --model` moves to the
  ONNX model;
- Docker: run `bootstrap` again — it keeps the projects and model folders your entries mount; image
  tags follow releases — `:latest` is 3.x, `:2` is the 2.x line, `:edge` is `main`;
- the agent hooks gain two defaults — a supply-chain check before installs and a security review
  before a session ends — each with its switch in `.ai-dev/policy.json`.

## Going back

`:2` is the 2.x image: `sh ./bootstrap.sh --image ghcr.io/stonebridgeway/ai-dev-system:2`. For a
clone, npm and the Windows app, see [The way back](https://github.com/stonebridgeway/ai-dev-system/blob/main/docs/MIGRATION.md#the-way-back).

Full list of changes: [CHANGELOG](https://github.com/stonebridgeway/ai-dev-system/blob/main/CHANGELOG.md).
