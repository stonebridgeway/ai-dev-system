[CmdletBinding()]
param(
  [string]$VaultRoot,
  [switch]$IncludeDense
)

# 2.x ran the gate once with this script, looking for Node in the Codex desktop
# runtime. It is `npm run check` now, on any system, with Node from PATH,
# then the Frontend QA runner's tests when its
# dependencies are installed; `npm run acceptance` runs the gate ten times. With
# -IncludeDense the dense checks follow: `ai-dev doctor --dense-smoke
# --search-eval`. This wrapper stays until 4.0 and says so on stderr.
$ErrorActionPreference = "Stop"
[Console]::Error.WriteLine("ai-dev: scripts/run-acceptance.ps1 is ``npm run check`` now (``npm run acceptance`` for ten runs); this wrapper stays until 4.0.")
$server = (Resolve-Path (Join-Path $PSScriptRoot "..\ai-dev-mcp-server")).Path
$node = if ($env:AI_DEV_NODE) { $env:AI_DEV_NODE } else { (Get-Command node -CommandType Application -ErrorAction SilentlyContinue).Source }
if (-not $node) { throw "Node.js not found. Install Node 22.16+ or 24+, or set AI_DEV_NODE." }
$npm = (Get-Command npm -CommandType Application -ErrorAction SilentlyContinue).Source
if (-not $npm) { throw "npm not found on PATH; it comes with Node." }
if ($VaultRoot) { $env:AI_DEV_VAULT_ROOT = (Resolve-Path -LiteralPath $VaultRoot).Path }
Push-Location $server
try {
  & $npm run check
  if ($LASTEXITCODE -ne 0) { throw "npm run check failed." }
  # The Frontend QA runner's own tests, which 2.x ran here too; they need its
  # dependencies, which `npm run setup -- --frontend-qa` installs.
  $frontendQa = (Resolve-Path (Join-Path $PSScriptRoot "..\frontend-qa")).Path
  if (Test-Path -LiteralPath (Join-Path $frontendQa "node_modules")) {
    Push-Location $frontendQa
    try {
      & $node --test
      if ($LASTEXITCODE -ne 0) { throw "Frontend QA tests failed." }
    } finally { Pop-Location }
  } else {
    [Console]::Error.WriteLine("ai-dev: Frontend QA tests skipped: its dependencies are not installed (npm run setup -- --frontend-qa).")
  }
  if ($IncludeDense) {
    & $node "bin\ai-dev.mjs" doctor --dense-smoke --search-eval
    if ($LASTEXITCODE -ne 0) { throw "The dense checks failed." }
  }
} finally { Pop-Location }
