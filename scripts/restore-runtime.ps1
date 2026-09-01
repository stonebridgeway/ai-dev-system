[CmdletBinding()]
param(
  [string]$VaultRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
)

$ErrorActionPreference = "Stop"

function Resolve-Tool([string]$explicit, [string]$name, [string[]]$candidates) {
  if ($explicit -and (Test-Path -LiteralPath $explicit -PathType Leaf)) { return $explicit }
  $onPath = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  foreach ($candidate in $candidates) {
    $full = Join-Path $env:USERPROFILE $candidate
    if (Test-Path -LiteralPath $full -PathType Leaf) { return $full }
  }
  throw "$name not found on PATH. Install it or pass an explicit path."
}

$node = Resolve-Tool $env:AI_DEV_NODE "node" @(".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
$npm = Resolve-Tool $null "npm" @(".codex\runtimes\npm-11.6.2\node_modules\npm\bin\npm-cli.js")
$pnpm = Resolve-Tool $null "pnpm" @(".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd")
$server = Join-Path $VaultRoot "09-mcp\ai-dev-mcp-server"
$frontendQa = Join-Path $VaultRoot "09-mcp\frontend-qa"

Push-Location $server
try {
  if ($npm.EndsWith(".js")) { & $node $npm ci --ignore-scripts --no-audit --no-fund }
  else { & $npm ci --ignore-scripts --no-audit --no-fund }
  if ($LASTEXITCODE -ne 0) { throw "MCP dependency restore failed." }
} finally { Pop-Location }

Push-Location $frontendQa
try {
  & $pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "Frontend QA dependency restore failed." }
} finally { Pop-Location }

[pscustomobject]@{
  status = "restored"
  node = $node
  npm = $npm
  server = $server
  frontend_qa = $frontendQa
}
