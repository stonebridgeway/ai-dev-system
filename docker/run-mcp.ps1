$ErrorActionPreference = "Stop"

function Write-AiDevDiagnostic([string]$Message) {
    if (-not $env:AI_DEV_DEBUG_LOG) { return }
    try {
        $directory = Split-Path -Parent $env:AI_DEV_DEBUG_LOG
        if ($directory) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
        Add-Content -LiteralPath $env:AI_DEV_DEBUG_LOG -Value "$(Get-Date -Format o) $Message" -Encoding utf8
    } catch {
        # Diagnostics must never interfere with MCP stdio.
    }
}

$image = if ($env:AI_DEV_IMAGE) { $env:AI_DEV_IMAGE } else { "ai-dev-system:local" }
$dataVolume = if ($env:AI_DEV_DATA_VOLUME) { $env:AI_DEV_DATA_VOLUME } else { "ai-dev-system-data" }
$network = if ($env:AI_DEV_DOCKER_NETWORK) { $env:AI_DEV_DOCKER_NETWORK } else { "none" }

$dockerArgs = @(
    "run",
    "--rm",
    "-i",
    "--read-only",
    "--tmpfs", "/tmp:rw,exec,nosuid,size=512m",
    "--shm-size", "1g",
    "--network", $network,
    "--security-opt", "no-new-privileges:true",
    "--cap-drop", "ALL",
    "--mount", "type=volume,source=$dataVolume,target=/data"
)

if ($env:AI_DEV_PROJECT_PATH) {
    $projectPath = (Resolve-Path -LiteralPath $env:AI_DEV_PROJECT_PATH).Path
    if ($projectPath.Contains(",")) {
        throw "AI_DEV_PROJECT_PATH cannot contain a comma when Docker --mount syntax is used."
    }
    $dockerArgs += @("--mount", "type=bind,source=$projectPath,target=/workspace")
}

if ($env:AI_DEV_MODEL_PATH) {
    $modelPath = (Resolve-Path -LiteralPath $env:AI_DEV_MODEL_PATH).Path
    if ($modelPath.Contains(",")) {
        throw "AI_DEV_MODEL_PATH cannot contain a comma when Docker --mount syntax is used."
    }
    $dockerArgs += @("--mount", "type=bind,source=$modelPath,target=/models/bge-m3,readonly")
}

$dockerArgs += $image
Write-AiDevDiagnostic "Launching Docker image '$image'; project mount configured: $([bool]$env:AI_DEV_PROJECT_PATH)."
try {
    & docker @dockerArgs
    $exitCode = $LASTEXITCODE
    Write-AiDevDiagnostic "Docker process exited with code $exitCode."
    exit $exitCode
} catch {
    $message = $_.Exception.Message
    Write-AiDevDiagnostic "Launcher failed: $message"
    [Console]::Error.WriteLine("AI Dev MCP launcher failed: $message")
    exit 1
}
