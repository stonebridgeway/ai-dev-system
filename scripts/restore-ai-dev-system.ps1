[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Archive,
  [string]$TargetRoot,
  [switch]$AllowNonEmpty,
  [switch]$ConfirmRestore
)

# 2.x restored with this script, and only a whole vault. It is `ai-dev restore`
# now: an archive of either kind, checked file by file. Without -TargetRoot a
# backup `ai-dev backup` made goes back where it
# came from. This wrapper stays until 4.0 and says so on stderr.
$ErrorActionPreference = "Stop"
[Console]::Error.WriteLine("ai-dev: scripts/restore-ai-dev-system.ps1 is ``ai-dev restore`` now; this wrapper stays until 4.0.")
if (-not $ConfirmRestore) { throw "Restore is blocked until -ConfirmRestore is supplied." }
$cli = Join-Path $PSScriptRoot "..\ai-dev-mcp-server\bin\ai-dev.mjs"
$node = if ($env:AI_DEV_NODE) { $env:AI_DEV_NODE } else { (Get-Command node -CommandType Application -ErrorAction SilentlyContinue).Source }
if (-not $node) { throw "Node.js not found. Install Node 22.16+ or 24+, or set AI_DEV_NODE." }
$arguments = @($cli, "restore", $Archive, "--confirm")
if ($TargetRoot) { $arguments += @("--to", $TargetRoot) }
if ($AllowNonEmpty) { $arguments += "--overwrite" }
& $node @arguments
exit $LASTEXITCODE
