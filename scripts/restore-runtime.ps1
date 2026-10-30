[CmdletBinding()]
param(
  [string]$VaultRoot
)

# 2.x reinstalled the server's and Frontend QA's dependencies with this script,
# looking for Node and npm in the Codex desktop runtime. A clone does it with
# `npm ci` and `ai-dev setup --frontend-qa`, on any system, with Node from PATH;
# this wrapper runs those two and stays until 4.0.
$ErrorActionPreference = "Stop"
[Console]::Error.WriteLine("ai-dev: scripts/restore-runtime.ps1 is ``npm ci`` plus ``ai-dev setup --frontend-qa`` now; this wrapper stays until 4.0.")
$server = (Resolve-Path (Join-Path $PSScriptRoot "..\ai-dev-mcp-server")).Path
$node = if ($env:AI_DEV_NODE) { $env:AI_DEV_NODE } else { (Get-Command node -CommandType Application -ErrorAction SilentlyContinue).Source }
if (-not $node) { throw "Node.js not found. Install Node 22.16+ or 24+, or set AI_DEV_NODE." }
$npm = (Get-Command npm -CommandType Application -ErrorAction SilentlyContinue).Source
if (-not $npm) { throw "npm not found on PATH; it comes with Node." }
if ($VaultRoot) { $env:AI_DEV_VAULT_ROOT = (Resolve-Path -LiteralPath $VaultRoot).Path }
Push-Location $server
try {
  & $npm ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
  & $node "bin\ai-dev.mjs" setup --frontend-qa --no-clients
  exit $LASTEXITCODE
} finally { Pop-Location }
