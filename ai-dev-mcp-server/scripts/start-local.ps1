[CmdletBinding()]
param(
  [string]$Node = $env:AI_DEV_NODE,
  [string]$VaultRoot = $env:AI_DEV_VAULT_ROOT
)

$ErrorActionPreference = "Stop"
$serverRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Node) {
  $Node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
}
if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) {
  throw "Node.js runtime not found: $Node"
}
if ($VaultRoot) {
  $env:AI_DEV_VAULT_ROOT = (Resolve-Path -LiteralPath $VaultRoot).Path
}

Push-Location $serverRoot
try {
  & $Node "src\server.mjs"
  if ($LASTEXITCODE -ne 0) { throw "AI Dev MCP server exited with code $LASTEXITCODE." }
}
finally {
  Pop-Location
}
