[CmdletBinding()]
param(
  [string]$Node = $env:AI_DEV_NODE,
  [string]$VaultRoot = $env:AI_DEV_VAULT_ROOT
)

# 2.x started the server with this script. It is `ai-dev mcp` now
# (bin\ai-dev.mjs), which `ai-dev clients install` writes into every client's
# config. This script stays until 4.0 and says so on stderr: stdout is the MCP
# channel.
$ErrorActionPreference = "Stop"
[Console]::Error.WriteLine("ai-dev: scripts/start-local.ps1 is ``ai-dev mcp`` now (node bin\ai-dev.mjs mcp); this script stays until 4.0.")
$serverRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Node) {
  # Node on PATH. The Codex desktop runtime's private Node is not looked for any
  # more: set AI_DEV_NODE to use one.
  $onPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
  if ($onPath) { $Node = $onPath.Source }
}
if (-not $Node -or -not (Test-Path -LiteralPath $Node -PathType Leaf)) {
  throw "Node.js 24+ not found. Install Node, or pass -Node <path> / set AI_DEV_NODE."
}
if ($VaultRoot) {
  $env:AI_DEV_VAULT_ROOT = (Resolve-Path -LiteralPath $VaultRoot).Path
}

Push-Location $serverRoot
try {
  & $Node "bin\ai-dev.mjs" "mcp"
  if ($LASTEXITCODE -ne 0) { throw "AI Dev MCP server exited with code $LASTEXITCODE." }
}
finally {
  Pop-Location
}
