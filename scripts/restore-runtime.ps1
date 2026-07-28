[CmdletBinding()]
param(
  [string]$VaultRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
)

$ErrorActionPreference = "Stop"
$node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$npm = Join-Path $env:USERPROFILE ".codex\runtimes\npm-11.6.2\node_modules\npm\bin\npm-cli.js"
$pnpm = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
$server = Join-Path $VaultRoot "09-mcp\ai-dev-mcp-server"
$frontendQa = Join-Path $VaultRoot "09-mcp\frontend-qa"

foreach ($required in @($node, $npm, $pnpm)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required local runtime is missing: $required" }
}

Push-Location $server
try {
  & $node $npm ci --ignore-scripts --no-audit --no-fund
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
