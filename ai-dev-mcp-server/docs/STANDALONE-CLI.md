# Standalone CLI

The local-first entry point is `ai-dev`. Install the published package with Node 22.12 or newer, then run `ai-dev setup`.

`setup` downloads the checksum-pinned BGE-M3 artifacts, installs requested client entries, and starts the per-user daemon. It never modifies a repository. Use `--no-model`, `--no-clients`, or `--no-daemon` to defer a setup step.

MCP clients launch `ai-dev serve`, a stdio bridge that connects to a single local daemon through a private socket. Runtime state, task records, model artifacts, daemon data, and trust records stay under `AI_DEV_HOME` (default `~/.ai-dev`).

Before AI Dev runs a repository command, explicitly approve it with `ai-dev trust <path>` or the `trust_project` MCP tool. Inspect, remove, or list those entries with `ai-dev trust --list` and `ai-dev trust --remove <path>`.

Operational commands:

- `ai-dev models status|pull` validates or downloads every BGE-M3 artifact by SHA-256.
- `ai-dev doctor` reports Node, daemon, model, and trusted-project status with recovery commands.
- `ai-dev tasks [show <id>]` reads task records from the local state directory.
- `ai-dev install-client [codex|cursor|gemini|vscode|claude]` writes an `ai-dev serve` MCP entry.
- `ai-dev upgrade` updates the global npm installation after gracefully stopping the daemon.
- `ai-dev uninstall [--purge]` stops the daemon; only `--purge` removes local runtime state. Neither form changes repositories.
