# The 2.x launcher, kept so that the client configs naming it — and its copy in
# C:\ProgramData\AI-Dev-System that bootstrap.ps1 made — work until 4.0. 3.0
# writes `docker run -i --rm ...` into a client's config itself
# (bootstrap.ps1, or `ai-dev clients install --docker`); this runs the same image
# the way it always did.
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

[Console]::Error.WriteLine("ai-dev: this client config runs run-mcp.ps1, the 2.x launcher, which works until 4.0. Run bootstrap.ps1 (or ``ai-dev clients install --docker``) to write the 3.0 entry: docker run, with the state your agent hooks share.")

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
    # The folder above the model: it holds bge-m3-onnx/.
    # A bge-m3/ beside it is the Python backend's weights, which 3.0 removed:
    # said, not taken for a model.
    #
    # In 2.0.0 the variable named the model directory itself. A folder that
    # holds model files is that old value; mounted at /models it would leave both
    # backends looking one level too deep and reporting "not set up".
    foreach ($marker in @("pytorch_model.bin", "modules.json", "config.json", "onnx")) {
        if (Test-Path -LiteralPath (Join-Path $modelPath $marker)) {
            throw "AI_DEV_MODEL_PATH now names the folder above the models, and $modelPath holds model files itself ($marker). Point it at the parent folder that contains bge-m3-onnx\ - for a default install that is $HOME\.ai-dev\models (docs/INSTALL.md)."
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $modelPath "bge-m3-onnx"))) {
        if (Test-Path -LiteralPath (Join-Path $modelPath "bge-m3")) {
            [Console]::Error.WriteLine("AI_DEV_MODEL_PATH=$modelPath holds bge-m3\, the weights of the Python backend 3.0 removed, and no bge-m3-onnx\; dense search will report that it is not set up. Put the ONNX model there: npm run model -- install --dir $modelPath\bge-m3-onnx (docs/INSTALL.md).")
        } else {
            [Console]::Error.WriteLine("AI_DEV_MODEL_PATH=$modelPath holds no bge-m3-onnx\; dense search will report that it is not set up until a model is put there.")
        }
    }
    $dockerArgs += @("--mount", "type=bind,source=$modelPath,target=/models,readonly")
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
