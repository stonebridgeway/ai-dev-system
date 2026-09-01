[CmdletBinding()]
param(
  [string]$VaultRoot,
  [switch]$IncludeDense
)

$ErrorActionPreference = "Stop"
if (-not $VaultRoot) {
  $VaultRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

function Resolve-Runtime([string]$explicit, [string]$name, [string]$codexRelative) {
  if ($explicit -and (Test-Path -LiteralPath $explicit -PathType Leaf)) { return $explicit }
  $onPath = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  $codex = Join-Path $env:USERPROFILE $codexRelative
  if (Test-Path -LiteralPath $codex -PathType Leaf) { return $codex }
  throw "$name not found. Install it, or set AI_DEV_NODE / AI_DEV_PYTHON."
}

$node = Resolve-Runtime $env:AI_DEV_NODE "node" ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$python = Resolve-Runtime $env:AI_DEV_PYTHON "python" ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$server = Join-Path $VaultRoot "09-mcp\ai-dev-mcp-server"
$frontendQa = Join-Path $VaultRoot "09-mcp\frontend-qa"
$search = Join-Path $VaultRoot "09-mcp\search-index"

Push-Location $server
try {
  & $node "scripts\static-quality.mjs"
  if ($LASTEXITCODE -ne 0) { throw "MCP static quality gate failed." }
  & $node --test --experimental-test-coverage "--test-coverage-include=src/core/*.mjs" "--test-coverage-exclude=src/core/*.test.mjs" "--test-coverage-lines=85" "--test-coverage-branches=60" "--test-coverage-functions=85"
  if ($LASTEXITCODE -ne 0) { throw "MCP tests or coverage thresholds failed." }
  & $node "scripts\security-check.mjs"
  if ($LASTEXITCODE -ne 0) { throw "MCP security gate failed." }
  & $node "scripts\protocol-smoke.mjs"
  if ($LASTEXITCODE -ne 0) { throw "MCP protocol smoke failed." }
  & $node "scripts\lifecycle-smoke.mjs"
  if ($LASTEXITCODE -ne 0) { throw "Task lifecycle smoke failed." }
} finally { Pop-Location }

Push-Location $frontendQa
try {
  & $node --test
  if ($LASTEXITCODE -ne 0) { throw "Frontend QA tests failed." }
} finally { Pop-Location }

Push-Location $search
try {
  # Python's unittest runner writes normal progress to stderr. PowerShell 5
  # surfaces that stream as NativeCommandError when Stop is active, so merge
  # the streams and trust the native exit code.
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $python -m unittest discover -s . -p "test_*.py" -v 2>&1 |
      ForEach-Object {
        $line = [string]$_
        if ($line -ne "System.Management.Automation.RemoteException") {
          Write-Output $line
        }
      }
    $pythonExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($pythonExitCode -ne 0) { throw "Search index tests failed." }
} finally { Pop-Location }

if ($IncludeDense) {
  Push-Location $server
  try {
    $script = @'
import { callTool, shutdownBgeWorkers } from "./src/mcp-stdio.mjs";
const response = await callTool("run_search_eval", { include_dense: true, max_cases: 100 });
const report = JSON.parse(response.content[0].text);
console.log(JSON.stringify({ status: report.status, summary: report.summary }, null, 2));
await shutdownBgeWorkers();
if (report.status !== "ok") process.exit(1);
'@
    $script | & $node --input-type=module
    if ($LASTEXITCODE -ne 0) { throw "Dense search evaluation failed." }
  } finally { Pop-Location }
}

[pscustomobject]@{
  status = "pass"
  dense_search = [bool]$IncludeDense
}
