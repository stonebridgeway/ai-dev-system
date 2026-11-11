[CmdletBinding()]
param(
  [string]$VaultRoot,
  [string]$Destination,
  [string]$Label = "manual"
)

# 2.x backed up with this script, and only inside a full vault. It is
# `ai-dev backup` now: every layout, every system, the vault and AI Dev's state
# with each file's sha256. This wrapper stays until
# 4.0 and says so on stderr.
$ErrorActionPreference = "Stop"
[Console]::Error.WriteLine("ai-dev: scripts/backup-ai-dev-system.ps1 is ``ai-dev backup`` now; this wrapper stays until 4.0.")
$cli = Join-Path $PSScriptRoot "..\ai-dev-mcp-server\bin\ai-dev.mjs"
$node = if ($env:AI_DEV_NODE) { $env:AI_DEV_NODE } else { (Get-Command node -CommandType Application -ErrorAction SilentlyContinue).Source }
if (-not $node) { throw "Node.js not found. Install Node 22.16+ or 24+, or set AI_DEV_NODE." }
if ($VaultRoot) { $env:AI_DEV_VAULT_ROOT = (Resolve-Path -LiteralPath $VaultRoot).Path }
$arguments = @($cli, "backup", $Label)
if ($Destination) { $arguments += @("--to", $Destination) }
& $node @arguments
exit $LASTEXITCODE
