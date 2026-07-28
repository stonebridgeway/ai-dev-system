# Backup And Recovery

## Current vNext Checkpoint

The pre-migration source checkpoint is stored under:

`${CODEX_HOME}/backups/ai-dev-system-vnext/YYYY-MM-DD_HH-MM-SS`

It excludes models, virtual environments, generated SQLite databases, and runtime artifacts.

Create a current source backup:

```powershell
09-mcp\scripts\backup-ai-dev-system.ps1 -Label before-change
```

The script writes a ZIP, manifest, and SHA-256 sidecar under
`%USERPROFILE%\.codex\backups\ai-dev-system`. It includes local vault content and must remain private.

## Recovery Order

1. Stop Codex so the stdio server is not writing.
2. Restore the MCP source and registry folders from the checkpoint.
3. Restore the matching `codex-config.toml` MCP block if the entry point changed.
4. Restore pinned dependencies:
   `09-mcp\scripts\restore-runtime.ps1`.
5. Run `09-mcp\scripts\run-acceptance.ps1 -IncludeDense`.
6. Run MCP `system_health_check` with dense smoke enabled.
7. Switch Codex back to `src/server.mjs` only after these checks pass.
8. Rebuild disposable SQLite and dense indexes.

Do not restore cache databases over newer knowledge. Rebuild them from source notes instead.

## Safe Restore Test

Restore into a new empty directory first:

```powershell
09-mcp\scripts\restore-ai-dev-system.ps1 `
  -Archive <backup.zip> `
  -TargetRoot <empty-test-folder> `
  -ConfirmRestore
```

The restore rejects missing manifests, non-empty targets by default, and ZIP entries that escape the
target directory. Never test recovery directly over the active Obsidian vault.
