[CmdletBinding()]
param(
    [string]$ProjectPath = (Join-Path $HOME "AI-Dev-Projects"),
    [string]$Image = "ai-dev-system:local",
    [string]$Clients = "codex,cursor,gemini,vscode,claude",
    [switch]$SkipSmoke,
    [switch]$SkipClientInstall,
    [switch]$Plan
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSCommandPath
$serverRoot = Join-Path $repoRoot "ai-dev-mcp-server"
$launcher = Join-Path $repoRoot "docker\run-mcp.ps1"

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-Prerequisite([string]$DisplayName, [string]$WingetId) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "$DisplayName is missing and winget is unavailable. Install $DisplayName manually, then run this script again."
    }
    if (-not (Test-Administrator)) {
        throw "$DisplayName is missing. Run bootstrap.ps1 from an elevated PowerShell once so winget can install it."
    }
    Write-Host "Installing $DisplayName through winget..."
    & winget install --exact --id $WingetId --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "winget could not install $DisplayName (exit code $LASTEXITCODE). Complete the installation, open a new terminal, and run this script again."
    }
}

function Get-NodeCommand {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $node) { return $null }
    return $node.Source
}

function Ensure-Node {
    $node = Get-NodeCommand
    if (-not $node) {
        Install-Prerequisite "Node.js 24 LTS" "OpenJS.NodeJS.LTS"
        $nodeBin = Join-Path $env:ProgramFiles "nodejs"
        if (Test-Path -LiteralPath $nodeBin) { $env:PATH = "$nodeBin;$env:PATH" }
        $node = Get-NodeCommand
    }
    if (-not $node) {
        throw "Node.js was installed but is not available in this terminal. Open a new PowerShell window and run bootstrap.ps1 again."
    }
    $version = (& $node --version).Trim()
    $major = [int](($version -replace '^v', '').Split('.')[0])
    if ($major -lt 24) {
        throw "Node.js 24 or newer is required; found $version. Update Node.js and run bootstrap.ps1 again."
    }
    return $node
}

function Ensure-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Install-Prerequisite "Docker Desktop" "Docker.DockerDesktop"
    }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker Desktop was installed but docker is not available in this terminal. Open a new PowerShell window, start Docker Desktop, and run bootstrap.ps1 again."
    }
    & docker version --format '{{.Server.Version}}' 2>$null
    if ($LASTEXITCODE -eq 0) { return }

    $desktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    if (Test-Path -LiteralPath $desktop) {
        Write-Host "Starting Docker Desktop and waiting for the engine..."
        Start-Process -FilePath $desktop -WindowStyle Hidden
        foreach ($attempt in 1..24) {
            Start-Sleep -Seconds 5
            & docker version --format '{{.Server.Version}}' 2>$null
            if ($LASTEXITCODE -eq 0) { return }
        }
    }
    throw "Docker Desktop is not ready. Open Docker Desktop, wait until it reports Running, then run bootstrap.ps1 again."
}

function Get-NpmCommand([string]$NodePath) {
    $candidate = Join-Path (Split-Path -Parent $NodePath) "npm.cmd"
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw "npm is missing next to Node.js. Repair the Node.js installation and run bootstrap.ps1 again." }
    return $npm.Source
}

function Install-ClientLauncher([string]$SourceLauncher, [string]$FileName = "run-mcp.ps1") {
    $sharedRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    $targetRoot = Join-Path $sharedRoot "AI-Dev-System"
    $target = Join-Path $targetRoot $FileName
    try {
        New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
        Copy-Item -LiteralPath $SourceLauncher -Destination $target -Force
        return $target
    } catch {
        throw "Could not install the ASCII-path MCP launcher at $target. Run bootstrap.ps1 from an elevated PowerShell, then try again. $($_.Exception.Message)"
    }
}

function Install-ClaudeMcpProxy {
    $sharedRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    $targetRoot = Join-Path $sharedRoot "AI-Dev-System"
    $source = Join-Path $repoRoot "docker\ClaudeMcpProxy.cs"
    $stagedSource = Join-Path $targetRoot "ClaudeMcpProxy.cs"
    $target = Join-Path $targetRoot "ClaudeMcpProxy.exe"
    $compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not (Test-Path -LiteralPath $compiler)) {
        throw "Windows .NET Framework compiler is unavailable: $compiler"
    }
    try {
        New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $stagedSource -Force
        & $compiler /nologo /target:exe "/out:$target" $stagedSource
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $target)) {
            throw "C# compiler exited with code $LASTEXITCODE."
        }
        return $target
    } catch {
        throw "Could not install the Claude fast-start MCP proxy. $($_.Exception.Message)"
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $serverRoot "package.json"))) {
    throw "Run this script from a complete AI Dev MCP System clone. Missing: $serverRoot\package.json"
}

$resolvedProjectPath = [IO.Path]::GetFullPath($ProjectPath)
if ($Plan) {
    [pscustomobject]@{
        repository = $repoRoot
        project_path = $resolvedProjectPath
        image = $Image
        clients = $Clients
        installs_prerequisites_when_missing = $true
        writes_only_local_client_config = $true
    } | ConvertTo-Json -Depth 3
    exit 0
}

$node = Ensure-Node
$env:PATH = "$(Split-Path -Parent $node);$env:PATH"
Ensure-Docker
$npm = Get-NpmCommand $node

New-Item -ItemType Directory -Path $resolvedProjectPath -Force | Out-Null
Push-Location $serverRoot
try {
    Write-Host "Installing locked server dependencies..."
    & $npm ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit code $LASTEXITCODE)." }

    Write-Host "Preparing and auditing the private-data-safe Docker context..."
    & $npm run docker:prepare
    if ($LASTEXITCODE -ne 0) { throw "Docker context preparation failed (exit code $LASTEXITCODE)." }
    & $npm run docker:audit
    if ($LASTEXITCODE -ne 0) { throw "Docker privacy audit failed (exit code $LASTEXITCODE)." }
} finally {
    Pop-Location
}

Write-Host "Building $Image..."
& docker build --tag $Image (Join-Path $repoRoot ".docker\build-context")
if ($LASTEXITCODE -ne 0) { throw "Docker image build failed (exit code $LASTEXITCODE)." }

if (-not $SkipSmoke) {
    Push-Location $serverRoot
    try {
        Write-Host "Running MCP smoke test..."
        & $npm run docker:smoke -- --image $Image
        if ($LASTEXITCODE -ne 0) { throw "Docker MCP smoke test failed (exit code $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }
}

if (-not $SkipClientInstall) {
    Write-Host "Installing local MCP client configurations..."
    $clientLauncher = Install-ClientLauncher $launcher
    $claudeLauncher = Install-ClaudeMcpProxy
    $env:AI_DEV_INSTALLER_LAUNCHER = $clientLauncher
    & $node (Join-Path $serverRoot "scripts\install-docker-mcp-clients.mjs") `
        --apply `
        --launcher-env AI_DEV_INSTALLER_LAUNCHER `
        --claude-launcher $claudeLauncher `
        --image $Image `
        --project-path $resolvedProjectPath `
        --clients $Clients
    if ($LASTEXITCODE -ne 0) { throw "MCP client configuration failed (exit code $LASTEXITCODE)." }
}

Write-Host "AI Dev MCP System is ready. Restart the selected AI clients to load the ai-dev MCP server."
