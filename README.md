# AI Dev MCP System

A local system for developing with AI agents. It provides MCP tools for repository context,
a knowledge base and skills, search, running quality gates, and verifiable task tracking.
The server runs over `stdio`: it does not open a network port and does not require a remote
MCP server.

You connect to it not "the model directly," but an MCP-compatible client with a model selected:
Codex, Cursor, Claude Desktop or Claude Code, VS Code with MCP, Gemini CLI/Code Assist, or another
MCP host. The same local configuration is available to all of these clients.

## What's included

- a local MCP server on Node.js;
- a knowledge base, project context, and a managed skills library;
- hybrid search: SQLite FTS, sparse search, and an optional local BGE-M3;
- task lifecycle: `begin_task`, `checkpoint_task`, `verify_task`, `complete_task`;
- quality gate, security checks, and Frontend QA with Playwright/Chromium;
- a Docker image for the team: no personal Vault, passwords, tokens, projects, or task history.

## Requirements

For the Docker variant:

- Docker Desktop (Windows/macOS) or Docker Engine (Linux); bootstrap can install it;
- Docker must have access to the chosen projects folder.

To run from source you additionally need Node.js 24 and npm. On Windows you can use the
bundled Codex runtime described in the [server README](ai-dev-mcp-server/README.md).

## One-command run on Windows

After `git clone`, open PowerShell at the root of the clone and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

The script creates an isolated `AI-Dev-Projects` folder in your home directory, installs
Docker Desktop and Node.js 24 LTS via `winget` if they're missing, pulls the published image,
verifies MCP, and adds the local `ai-dev` server to Codex, Cursor, Gemini, VS Code, and Claude.
On Windows it also installs a launcher-only copy at
`C:\ProgramData\AI-Dev-System\run-mcp.ps1`: this avoids encoding issues when the clone's path
contains Cyrillic characters. No projects, Vault, tokens, or passwords are copied into that folder.
For Claude Desktop it additionally creates a compact `ClaudeMcpProxy.exe` in the same folder.
It answers MCP initialization before Docker starts, so Claude's short startup timeout is not hit;
after that, all traffic is transparently passed through to the local Docker container.
The first run must be done **as administrator** only if Docker Desktop or Node.js aren't
installed yet: `winget` and Docker may request elevation. If Docker Desktop is already
installed, a regular PowerShell is enough.

For a different repositories folder and choice of clients:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 `
  -ProjectPath "D:\Projects" `
  -Clients "codex,cursor,vscode"
```

The path is stored only in the local settings of the selected clients. No tokens, passwords,
the contents of this folder, or your profile are written to Git. Restart the AI client afterward.

## One-command run on macOS and Linux

If Docker is already installed and running:

```bash
sh ./bootstrap.sh
```

If Docker isn't installed yet, one command per system:

| System | Command after `git clone` |
| --- | --- |
| macOS | `sh ./bootstrap.sh --install-prerequisites` |
| Debian / Ubuntu | `sh ./bootstrap.sh --install-prerequisites` |
| Fedora | `sh ./bootstrap.sh --install-prerequisites` |
| Arch Linux / Manjaro | `sh ./bootstrap.sh --install-prerequisites` |

On macOS the script uses Homebrew: it installs Homebrew via the official installer if needed,
then runs `brew install --cask docker`, launches Docker Desktop, and waits for the engine to be
ready. The first launch of Docker Desktop may require accepting a license and confirming
privileged settings in the app window.

On Linux, `apt`, `dnf`, or `pacman` are used, the Docker service is enabled, and the current
user is added to the `docker` group. After that you need to log out and back in, then repeat
the command.

Bootstrap doesn't require Node.js on the host: to configure MCP clients it uses a temporary
`node:24` container. By default it pulls
`ghcr.io/stonebridgeway/ai-dev-system:latest`, and the working folder is created as
`~/AI-Dev-Projects` and mounted into the container as `/workspace`.

So that Claude Desktop and other clients don't time out on a slow cold Docker start, bootstrap
creates a service container named `ai-dev-system-runtime-$(id -u)`. It runs with no network,
a read-only filesystem, no Linux capabilities, and `no-new-privileges`; it only gets access to
the system's named volume and the selected projects folder. The MCP process itself is started
via a fast `docker exec`, and the launcher completes protocol initialization immediately. The
container comes back up automatically after a Docker restart thanks to `restart=unless-stopped`.

For a different projects folder and a subset of clients:

```bash
sh ./bootstrap.sh --project-path "$HOME/Dev" --clients "codex,cursor,vscode"
```

Re-running the same command safely updates only the managed runtime container. The named
volume, indexes, knowledge base, and project files are not removed. Check the runtime with:

```bash
docker ps --filter "label=ai-dev.system.runtime=true"
```

For developing the image itself, use explicit local mode:

```bash
sh ./bootstrap.sh --build-local
```

## Quick start: Docker

### 1. Get the image

```powershell
docker pull ghcr.io/stonebridgeway/ai-dev-system:latest
```

Or build the image from a clone of the repository:

```powershell
cd ai-dev-mcp-server
npm ci --ignore-scripts --no-audit --no-fund
npm run docker:prepare
npm run docker:audit
npm run docker:build
npm run docker:smoke -- --image ai-dev-system:local
```

The build always uses a temporary allowlist context at `.docker/build-context`, not the
repository root or an Obsidian Vault. Don't change the Docker context to the Vault root.

### 2. Choose a working folder

Create or choose a folder that contains only the repositories the agent is allowed to work
with. For example `C:\\Dev` on Windows or `$HOME/Dev` on macOS/Linux. This folder will be
mounted into the container as `/workspace`.

Do not point it at your personal Vault, your entire home folder, or a folder with secrets or
backups.

### 3. Verify a local run

Windows:

```powershell
$env:AI_DEV_IMAGE = "ghcr.io/stonebridgeway/ai-dev-system:latest"
$env:AI_DEV_PROJECT_PATH = "C:\\Dev"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\docker\\run-mcp.ps1
```

macOS/Linux:

```bash
export AI_DEV_IMAGE="ghcr.io/stonebridgeway/ai-dev-system:latest"
export AI_DEV_PROJECT_PATH="$HOME/Dev"
sh ./docker/run-mcp.sh
```

The process will wait for MCP messages on standard input. That's expected: end the check with
`Ctrl+C`, then point the launcher command at your MCP client.

## Connecting AI agents

In every case, replace `C:\\ABSOLUTE\\PATH` with the absolute path to a clone of this
repository, and `C:\\Dev` with your allowed projects folder. Don't commit these values to Git.

### Codex

Add to your user `config.toml`:

```toml
[mcp_servers.ai-dev]
command = "powershell.exe"
args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\ABSOLUTE\\PATH\\docker\\run-mcp.ps1"]
env = { AI_DEV_IMAGE = "ghcr.io/stonebridgeway/ai-dev-system:latest", AI_DEV_PROJECT_PATH = "C:\\Dev" }
startup_timeout_sec = 120
tool_timeout_sec = 3600
```

On macOS/Linux use `command = "/bin/sh"`, and pass the absolute path to `docker/run-mcp.sh` in
`args`. In `env` also set the name created by bootstrap:
`AI_DEV_RUNTIME_CONTAINER = "ai-dev-system-runtime-UID"`, where `UID` is the output of `id -u`.
The automatic installer does this for you. Restart Codex and verify that the `ai-dev` server
appears in the list of MCP tools.

### Cursor, Claude Desktop, Claude Code, and Gemini

These clients use JSON with an `mcpServers` property. Add or merge the block below with their
existing configuration:

When you run `bootstrap.ps1 -Clients claude`, the installer updates both local Claude files:
`%USERPROFILE%\\.claude.json` for Claude Code and
`%APPDATA%\\Claude\\claude_desktop_config.json` for Claude Desktop. Existing servers are
preserved, and the modified file is backed up. For the Microsoft Store version of Claude, the
installer also updates the app's isolated profile at `%LOCALAPPDATA%\\Packages\\Claude_*`.
On Windows, don't replace the automatically installed Claude configuration with the example
below: it uses `C:\ProgramData\AI-Dev-System\ClaudeMcpProxy.exe` for a fast Docker-MCP start.
On macOS/Linux, bootstrap likewise stores `AI_DEV_RUNTIME_CONTAINER` in the configuration and
wires up the fast launcher; you don't need to manually edit Claude's files after bootstrap.

```json
{
  "mcpServers": {
    "ai-dev": {
      "command": "powershell.exe",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\ABSOLUTE\\PATH\\docker\\run-mcp.ps1"
      ],
      "env": {
        "AI_DEV_IMAGE": "ghcr.io/stonebridgeway/ai-dev-system:latest",
        "AI_DEV_PROJECT_PATH": "C:\\Dev"
      }
    }
  }
}
```

A ready-made minimal template with no access to projects is at
[docker/mcp-config.example.json](docker/mcp-config.example.json). After changing the
configuration, fully restart the client. In Claude Code and Gemini CLI, the configuration can
also be added via their own MCP management command, but the launch command and environment
variables stay the same.

### VS Code

Create `.vscode/mcp.json` in a specific working repository, or add the same server to VS
Code's user MCP settings:

```json
{
  "servers": {
    "ai-dev": {
      "type": "stdio",
      "command": "powershell.exe",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\ABSOLUTE\\PATH\\docker\\run-mcp.ps1"
      ],
      "env": {
        "AI_DEV_IMAGE": "ghcr.io/stonebridgeway/ai-dev-system:latest",
        "AI_DEV_PROJECT_PATH": "C:\\Dev"
      }
    }
  }
}
```

Reload the VS Code window. Inside the container, paths to mounted repositories start with
`/workspace`; for example, use `/workspace/my-project` for `begin_task`.

## How to work with the agent

1. Open the desired repository in your chosen MCP client.
2. Give the agent a specific task and a path inside `/workspace`.
3. For substantial work, the agent runs `begin_task`, studies the generated context, and uses
   at most three well-chosen skills.
4. After changing code, the agent commits progress via `checkpoint_task`, runs `verify_task`,
   and finishes the work via `complete_task` only with up-to-date evidence.

Example request to the agent:

```text
Use the ai-dev MCP server. Start a task for /workspace/my-project:
add CSV export for the report, cover the change with tests, and run verify_task.
```

## Local data and security

The image contains only a vetted public seed: rules, prompts, quality gates, allowed skills,
and runtime. It does not include:

- passwords, tokens, `.env`, keys, and user configurations;
- your personal Obsidian Vault, `.codex`, `.ai-dev`, Git history, and local caches;
- `02-knowledge/Projects`, `02-knowledge/Task Runs`, indexes, logs, backup archives;
- your projects' source code and context;
- BGE-M3 model weights.

Data created by the container is stored in a local Docker volume named `ai-dev-system-data`.
Updating the image does not overwrite this volume. By default the container runs with no
network, not as root, with a read-only root filesystem, no Linux capabilities, and
`no-new-privileges`.

If a project genuinely needs internet access during verification, set
`AI_DEV_DOCKER_NETWORK=bridge` deliberately, only for that run.

## Docker Compose and BGE-M3

For Compose, copy `docker/compose.local.example.yaml` to `docker/compose.local.yaml`, set a
local `AI_DEV_PROJECT_PATH`, and run:

```bash
docker compose -f docker/compose.yaml -f docker/compose.local.yaml run --rm -T ai-dev-mcp
```

`compose.local.yaml` and `docker/.env` are Git-ignored, since they may contain local paths.

For more accurate semantic search, you can build a variant with BGE-M3:

```bash
docker build --build-arg INSTALL_BGE_M3=1 --tag ai-dev-system:bge .docker/build-context
```

Model weights are not embedded in the image. Mount your own local folder via
`AI_DEV_MODEL_PATH`; the launcher will mount it read-only as `/models/bge-m3`.

## Publishing for a team

The [docker-publish.yml](.github/workflows/docker-publish.yml) workflow checks the privacy
policy, rebuilds the allowlist context, runs an MCP smoke test, and publishes `linux/amd64` and
`linux/arm64` images to the GitHub Container Registry with SBOM and provenance.

After the first push:

1. Open the package on GitHub and choose `private/internal` visibility for the team, or
   `public`.
2. Make sure your colleagues have permission to read GitHub Packages.
3. Give colleagues the address `ghcr.io/stonebridgeway/ai-dev-system:latest` and this README.
4. Each colleague points `AI_DEV_PROJECT_PATH` at their own local projects folder; other
   people's files never end up in the image or in Git.

## Arch/AUR and Homebrew

The Arch package can be built from a clone:

```bash
cd packaging/arch
makepkg -si
ai-dev-system --install-prerequisites
```

The package name for a future AUR publication is `ai-dev-system-git`. The GitHub repository
itself cannot publish to the AUR without a separate AUR account and the maintainer's SSH
repository.

A HEAD formula is available on macOS:

```bash
brew install --HEAD --formula ./packaging/homebrew/ai-dev-system.rb
ai-dev-system --install-prerequisites
```

A shorter command via a Homebrew tap will require a separate
`stonebridgeway/homebrew-tap` repository. Details for maintainers are in
[packaging/README.md](packaging/README.md).

## Checks and diagnostics

Before a release, run from `ai-dev-mcp-server`:

```powershell
npm run check
npm run docker:prepare
npm run docker:audit
npm run docker:smoke -- --image ai-dev-system:local
```

For a full check of the whole suite:

```powershell
..\\scripts\\run-acceptance.ps1
```

If Docker Desktop can't pull the base image while a VPN or corporate DNS is active, configure
proxy/DNS in Docker Desktop. Don't pass proxy passwords into the Dockerfile, Git, build args,
or project files. An already-built local image runs without internet access.

Details on Compose, macOS/Linux, BGE-M3, and GHCR: [docker/README.md](docker/README.md).
Architecture and the full tool list: [ai-dev-mcp-server/README.md](ai-dev-mcp-server/README.md).

## Licenses

See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
