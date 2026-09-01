[CmdletBinding()]
param(
  [string]$Node = $env:AI_DEV_NODE,
  [string]$VaultRoot = $env:AI_DEV_VAULT_ROOT
)

$ErrorActionPreference = "Stop"
$serverRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Node) {
  # Prefer node on PATH; fall back to a bundled Codex runtime if one is present.
  $onPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
  if ($onPath) {
    $Node = $onPath.Source
  } else {
    $codexNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    if (Test-Path -LiteralPath $codexNode -PathType Leaf) { $Node = $codexNode }
  }
}
if (-not $Node -or -not (Test-Path -LiteralPath $Node -PathType Leaf)) {
  throw "Node.js 24+ not found. Install Node, or pass -Node <path> / set AI_DEV_NODE."
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
