[CmdletBinding()]
param(
    [string]$ProjectPath = "",
    [string]$ModelPath = $env:AI_DEV_MODEL_PATH,
    [string]$Image = "ghcr.io/stonebridgeway/ai-dev-system:latest",
    [string]$Clients = "all",
    [switch]$BuildLocal,
    [switch]$SkipSmoke,
    [switch]$AllowStaleImage,
    [switch]$SkipClientInstall,
    [switch]$Plan
)

# The Docker path on Windows: check Docker, pull the image, write the AI
# clients' configs. The configs run the image themselves, `docker run -i --rm ...`,
# written by `ai-dev clients install --docker` from this checkout with the Node
# on this machine (22.12+): a Linux container cannot write a config by its
# Windows path. Nothing is compiled here any more: 2.x built a C# proxy on the
# user's machine for Claude, and its launchers answered
# the MCP handshake themselves.

$ErrorActionPreference = "Stop"
$staleWarning = $null
if ($BuildLocal -and -not $PSBoundParameters.ContainsKey("Image")) {
    $Image = "ai-dev-system:local"
}
$repoRoot = Split-Path -Parent $PSCommandPath
$serverRoot = Join-Path $repoRoot "ai-dev-mcp-server"
$cli = Join-Path $serverRoot "bin\ai-dev.mjs"
$dataVolume = if ($env:AI_DEV_DATA_VOLUME) { $env:AI_DEV_DATA_VOLUME } else { "ai-dev-system-data" }

# Windows PowerShell 5.1 turns what a native command writes to a redirected
# stderr into error records, and with $ErrorActionPreference = "Stop" the first
# of them ends the script — and the image writes its first-run report to stderr
# at every start. A native command whose stderr is
# thrown away runs through here, with "Continue"; $LASTEXITCODE says how it did.
function Invoke-Native {
    param([Parameter(Mandatory = $true)][scriptblock]$Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $Command } finally { $ErrorActionPreference = $previous }
}

function Get-NodeCommand {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $node) { return $null }
    return $node.Source
}

function Assert-Node {
    $node = Get-NodeCommand
    if (-not $node) {
        throw "Node.js 22.12 or newer writes the AI clients' configs: install it (winget install OpenJS.NodeJS.LTS), open a new terminal and run bootstrap.ps1 again. Or install AI Dev with its Windows installer, which brings its own."
    }
    $version = (& $node --version).Trim()
    $major = [int](($version -replace '^v', '').Split('.')[0])
    $minor = [int](($version -replace '^v', '').Split('.')[1])
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 12)) {
        throw "Node.js 22.12 or newer is required; found $version. Update Node.js and run bootstrap.ps1 again."
    }
    return $node
}

function Assert-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker Desktop is required: install it (winget install Docker.DockerDesktop, or https://docs.docker.com/get-docker/), start it, and run bootstrap.ps1 again."
    }
    # The engine's version is only asked for to see that it answers: it is not printed.
    $null = Invoke-Native { & docker version --format '{{.Server.Version}}' 2>$null }
    if ($LASTEXITCODE -eq 0) { return }
    $desktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    if (Test-Path -LiteralPath $desktop) {
        Write-Host "Starting Docker Desktop and waiting for the engine..."
        Start-Process -FilePath $desktop -WindowStyle Hidden
        foreach ($attempt in 1..24) {
            Start-Sleep -Seconds 5
            $null = Invoke-Native { & docker version --format '{{.Server.Version}}' 2>$null }
            if ($LASTEXITCODE -eq 0) { return }
        }
    }
    throw "Docker Desktop is not ready. Open Docker Desktop, wait until it reports Running, then run bootstrap.ps1 again."
}

if (-not (Test-Path -LiteralPath $cli)) {
    throw "Run this script from a complete AI Dev clone. Missing: $cli"
}

# A folder not named is the one the entries this install replaces mount, found once the installer runs.
$projectGiven = [bool]$ProjectPath
$modelGiven = [bool]$ModelPath
$resolvedProjectPath = [IO.Path]::GetFullPath($(if ($ProjectPath) { $ProjectPath } else { Join-Path $HOME "AI-Dev-Projects" }))
$resolvedModelPath = $null
if ($ModelPath) {
    $resolvedModelPath = [IO.Path]::GetFullPath($ModelPath)
}
if ($Plan) {
    # Not $plan: variable names are case-insensitive, and $Plan is the switch
    # this block is answering.
    $planDocument = [pscustomobject]@{
        repository = $repoRoot
        project_path = $resolvedProjectPath
        image = $Image
        build_local = [bool]$BuildLocal
        clients = $Clients
        data_volume = $dataVolume
        installs_prerequisites_when_missing = $false
        writes_only_local_client_config = $true
    }
    # Present only when a model folder was given, so the default plan is unchanged.
    if ($resolvedModelPath) {
        $planDocument | Add-Member -NotePropertyName model_path -NotePropertyValue $resolvedModelPath
    }
    $planDocument | ConvertTo-Json -Depth 3
    exit 0
}

# The model folder, checked as Docker will mount it.
function Assert-ModelFolder {
    param([string]$Folder)
    if ($Folder.Contains(",")) {
        throw "Model path cannot contain a comma when Docker --mount syntax is used."
    }
    if (-not (Test-Path -LiteralPath $Folder -PathType Container)) {
        throw "Model path does not exist: $Folder"
    }
    # The folder above the model, holding bge-m3-onnx\, mounted read-only as
    # /models. A folder that holds model files itself is
    # the 2.0.0 value and would leave the model one level too deep.
    foreach ($marker in @("pytorch_model.bin", "modules.json", "config.json", "onnx")) {
        if (Test-Path -LiteralPath (Join-Path $Folder $marker)) {
            throw "-ModelPath names the folder above the models, and $Folder holds model files itself ($marker). Point it at the parent folder that contains bge-m3-onnx\ (docs/INSTALL.md)."
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Folder "bge-m3-onnx"))) {
        Write-Warning "$Folder holds no bge-m3-onnx\ yet; dense search will report that it is not set up until a model is put there."
    }
}
if ($resolvedModelPath) { Assert-ModelFolder $resolvedModelPath }

Assert-Docker
$node = $null
if ($BuildLocal -or -not $SkipClientInstall) {
    $node = Assert-Node
}

# A folder not named is the one the entries this install replaces mount — a 2.x entry's AI_DEV_PROJECT_PATH and
# AI_DEV_MODEL_PATH too — so running bootstrap again, or after 2.x, keeps what the server sees.
# Read as the UTF-8 Node writes, as the install's own answer below.
if (-not $SkipClientInstall -and (-not $projectGiven -or -not $modelGiven)) {
    $consoleEncoding = $null
    try {
        $consoleEncoding = [Console]::OutputEncoding
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    } catch {
        $consoleEncoding = $null
    }
    try {
        $entryFolders = @(Invoke-Native { & $node $cli clients folders "--clients=$Clients" 2>$null })
        # A lookup that fails says so.
        if ($LASTEXITCODE -ne 0) {
            $entryFolders = @()
            Write-Warning "Could not read the folders the clients' entries mount: name yours with -ProjectPath and -ModelPath, or the defaults stand."
        }
    } finally {
        if ($null -ne $consoleEncoding) { [Console]::OutputEncoding = $consoleEncoding }
    }
    foreach ($line in $entryFolders) {
        $role, $folder, $labels = "$line" -split "`t", 3
        # Only an absolute folder is taken from an entry: `~` or a relative one is a hand edit.
        if (($role -eq "projects" -or $role -eq "model") -and $folder -and -not [IO.Path]::IsPathRooted($folder)) {
            Write-Warning "$folder, the $role folder $labels mounted, is not an absolute path: it is not kept."
            continue
        }
        if ($role -eq "differ" -and (($folder -eq "projects" -and -not $projectGiven) -or ($folder -eq "model" -and -not $modelGiven))) {
            $flag = if ($folder -eq "projects") { "-ProjectPath" } else { "-ModelPath" }
            throw "The clients' entries mount different $folder folders: $labels. Name the one to keep with $flag."
        }
        if ($role -eq "projects" -and -not $projectGiven -and $folder) {
            $resolvedProjectPath = [IO.Path]::GetFullPath($folder)
            Write-Host "Projects folder: $resolvedProjectPath, the one $labels mounted (-ProjectPath names another)."
        }
        if ($role -eq "model" -and -not $modelGiven -and $folder) {
            # A folder that holds 2.x's Python model and not 3.0's is not kept; any other is, as the first install took it,
            # and checked as a named one is.
            $onnx = Test-Path -LiteralPath (Join-Path $folder "bge-m3-onnx") -PathType Container
            $python = (Test-Path -LiteralPath (Join-Path $folder "bge-m3") -PathType Container) -or (Test-Path -LiteralPath (Join-Path $folder "pytorch_model.bin"))
            if ((Test-Path -LiteralPath $folder -PathType Container) -and -not $onnx -and $python) {
                Write-Warning "$folder, the model folder $labels mounted, holds 2.x's Python model and no bge-m3-onnx\, which 3.0 runs: none is mounted; name one with -ModelPath."
            } elseif (Test-Path -LiteralPath $folder -PathType Container) {
                $resolvedModelPath = [IO.Path]::GetFullPath($folder)
                Assert-ModelFolder $resolvedModelPath
                Write-Host "Model folder: $resolvedModelPath, the one $labels mounted (-ModelPath names another)."
            } else {
                Write-Warning "$folder, the model folder $labels mounted, is not here: none is mounted; name one with -ModelPath."
            }
        }
    }
}
New-Item -ItemType Directory -Path $resolvedProjectPath -Force | Out-Null
if ($BuildLocal) {
    Write-Host "Preparing and auditing the Docker context..."
    & $node (Join-Path $serverRoot "scripts\prepare-docker-context.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Docker context preparation failed (exit code $LASTEXITCODE)." }
    & $node (Join-Path $serverRoot "scripts\audit-docker-context.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Docker context audit failed (exit code $LASTEXITCODE)." }
    Write-Host "Building $Image..."
    & docker build --tag $Image (Join-Path $repoRoot ".docker\build-context")
    if ($LASTEXITCODE -ne 0) { throw "Docker image build failed (exit code $LASTEXITCODE)." }
} else {
    Write-Host "Pulling $Image..."
    & docker pull $Image
    if ($LASTEXITCODE -ne 0) {
        Invoke-Native { & docker image inspect $Image *> $null }
        if ($LASTEXITCODE -ne 0) {
            throw "Could not pull $Image, and no cached copy exists."
        }
        # Installing whatever happened to be in the cache produced bug reports
        # about defects already fixed upstream, so the age
        # of that copy is stated and using it is a deliberate choice.
        $created = (Invoke-Native { & docker image inspect --format '{{.Created}}' $Image 2>$null } | Select-Object -First 1)
        $digest = (Invoke-Native { & docker image inspect --format '{{index .RepoDigests 0}}' $Image 2>$null } | Select-Object -First 1)
        if ([string]::IsNullOrWhiteSpace($created)) { $created = "unknown" }
        if ([string]::IsNullOrWhiteSpace($digest)) { $digest = "none (image was built locally)" }
        $staleWarning = "Registry pull failed. The cached copy of $Image was created $created (digest: $digest) and is missing anything released since."
        Write-Warning $staleWarning
        if (-not $AllowStaleImage) {
            throw "Stopping rather than installing an image of unknown age. Restore the registry connection and run again, or re-run with -AllowStaleImage to install this copy anyway."
        }
    }
}

if (-not $SkipSmoke) {
    Write-Host "Checking the MCP handshake..."
    # The server's own answer, instructions and all: 2.x checked for a serverInfo
    # a launcher wrote itself.
    $init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ai-dev-bootstrap","version":"1"}}}'
    $response = Invoke-Native { $init | & docker run --rm -i `
        --read-only `
        --tmpfs /tmp:rw,exec,nosuid,size=512m `
        --network none `
        --security-opt no-new-privileges:true `
        --cap-drop ALL `
        --mount "type=volume,source=$dataVolume,target=/data" `
        $Image 2>$null }
    if ($LASTEXITCODE -ne 0 -or ($response -join "`n") -notmatch '"instructions"') {
        throw "The server in $Image did not answer the MCP handshake."
    }
}

$noClient = $false
if (-not $SkipClientInstall) {
    $installArgs = @("clients", "install", "--docker", "--image=$Image", "--projects=$resolvedProjectPath", "--volume=$dataVolume", "--clients=$Clients")
    if ($resolvedModelPath) { $installArgs += "--model=$resolvedModelPath" }
    # Whether there is a client to write, from the installer's own answer as JSON, not from the words it prints:
    # with none, the hint is this script's -Clients, not the CLI's --clients, and nothing is written.
    # Only a dry run that passed and lists no client but skipped ones means none: one that failed — a client's
    # config it cannot read, say — leaves it to the install itself, which writes the others and names that one,
    # and whose exit decides. The dry run's stderr is thrown away: the install says it again.
    # Its answer is read as the UTF-8 Node writes: both PowerShells decode a native command's output in the console's
    # code page, and in a double-byte one (932, 936, 949, 950) a byte of a folder's name in UTF-8 takes the JSON's next
    # \ or " with it. A host that refuses the setting has its answer read as before.
    $consoleEncoding = $null
    try {
        $consoleEncoding = [Console]::OutputEncoding
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    } catch {
        $consoleEncoding = $null
    }
    try {
        $planned = Invoke-Native { & $node $cli @installArgs --dry-run --json 2>$null }
    } finally {
        if ($null -ne $consoleEncoding) { [Console]::OutputEncoding = $consoleEncoding }
    }
    $listed = $null
    if ($LASTEXITCODE -eq 0) {
        try { $listed = (($planned -join "`n") | ConvertFrom-Json).clients } catch { $listed = $null }
    }
    if ($null -ne $listed -and @($listed | Where-Object { $_.status -ne "skipped" }).Count -eq 0) {
        $noClient = $true
        # The ellipsis by its code: Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page. The
        # list in quotes: typed bare, PowerShell passes cursor,vscode as an array, which -Clients refuses.
        Write-Host "No AI client found here (Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini CLI). Name one to write its config anyway, -Clients `"cursor,vscode,$([char]0x2026)`", or install one and run bootstrap.ps1 again."
    } else {
        Write-Host "Writing the AI clients' configs..."
        & $node $cli @installArgs
        if ($LASTEXITCODE -ne 0) { throw "Writing the client configs failed (exit code $LASTEXITCODE)." }
    }

    # Configs of 2.x name the launcher bootstrap.ps1 copied here: it is brought up
    # to 3.0's, which says it is the 2.x one. The compiled
    # ClaudeMcpProxy.exe beside it is left as it is: nothing is compiled any more.
    $legacyLauncher = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) "AI-Dev-System\run-mcp.ps1"
    if (Test-Path -LiteralPath $legacyLauncher) {
        try {
            Copy-Item -LiteralPath (Join-Path $repoRoot "docker\run-mcp.ps1") -Destination $legacyLauncher -Force
        } catch {
            Write-Warning "Could not update the 2.x launcher at ${legacyLauncher}: $($_.Exception.Message)"
        }
    }
}

if ($staleWarning) {
    Write-Warning "Installed from a stale image. $staleWarning"
}
# The last line says what was done to the clients, no more, in bootstrap.sh's words, and after the stale image's
# warning, as there: a restart when there were clients to connect, written or already current.
if ($SkipClientInstall) {
    Write-Host "AI Dev is ready; the AI clients' configs were left as they were."
} elseif ($noClient) {
    Write-Host "AI Dev is ready; no AI client is connected to it yet."
} else {
    Write-Host "AI Dev is ready. Restart the AI clients to load ai-dev."
}
