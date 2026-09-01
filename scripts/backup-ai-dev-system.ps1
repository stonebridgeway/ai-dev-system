[CmdletBinding()]
param(
  [string]$VaultRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$Destination,
  [string]$Label = "manual"
)

$ErrorActionPreference = "Stop"
if (-not $Destination) {
  $aiDevHome = if ($env:AI_DEV_HOME) { $env:AI_DEV_HOME } else { Join-Path $env:USERPROFILE ".ai-dev" }
  $Destination = Join-Path $aiDevHome "backups"
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-ContainedRelativePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [Parameter(Mandatory = $true)]
    [string]$File
  )

  $rootPrefix = [System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/") +
    [System.IO.Path]::DirectorySeparatorChar
  $fullFile = [System.IO.Path]::GetFullPath($File)
  if (-not $fullFile.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Backup file is outside VaultRoot: $fullFile"
  }
  return $fullFile.Substring($rootPrefix.Length)
}

$source = (Resolve-Path -LiteralPath $VaultRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $source "09-mcp\ai-dev-mcp-server\package.json"))) {
  throw "VaultRoot does not look like AI-Dev-System: $source"
}

$destinationRoot = [System.IO.Path]::GetFullPath($Destination)
[System.IO.Directory]::CreateDirectory($destinationRoot) | Out-Null
$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$safeLabel = ($Label -replace '[^a-zA-Z0-9._-]+', '-').Trim('-')
if (-not $safeLabel) { $safeLabel = "manual" }
$archivePath = Join-Path $destinationRoot "ai-dev-system_${stamp}_${safeLabel}.zip"

$excludedDirectories = [System.Collections.Generic.HashSet[string]]::new(
  [string[]]@(".git", "node_modules", ".venv", "__pycache__", ".pytest_cache"),
  [System.StringComparer]::OrdinalIgnoreCase
)
$excludedFilePatterns = @(
  '\.sqlite(?:-(?:shm|wal))?$',
  '\.pyc$',
  '\.lock$',
  '\\frontend-qa\\fixtures\\.+\\\.ai-dev\\frontend-qa(?:-baselines)?\\',
  '\\\.obsidian\\cache\\'
)

$files = Get-ChildItem -LiteralPath $source -Recurse -File -Force | Where-Object {
  $relative = Get-ContainedRelativePath -Root $source -File $_.FullName
  $segments = $relative -split '[\\/]'
  if ($segments | Where-Object { $excludedDirectories.Contains($_) }) { return $false }
  foreach ($pattern in $excludedFilePatterns) {
    if ($relative -match $pattern) { return $false }
  }
  return $true
}

$archive = [System.IO.Compression.ZipFile]::Open(
  $archivePath,
  [System.IO.Compression.ZipArchiveMode]::Create
)
try {
  foreach ($file in $files) {
    $entryName = (Get-ContainedRelativePath -Root $source -File $file.FullName).Replace("\", "/")
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive,
      $file.FullName,
      $entryName,
      [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }

  $manifest = [ordered]@{
    schema_version = 1
    created_at = (Get-Date).ToUniversalTime().ToString("o")
    source_root = $source
    label = $safeLabel
    files = $files.Count
    excludes_disposable_indexes_and_runtimes = $true
    contains_local_vault_content = $true
  } | ConvertTo-Json -Depth 4
  $entry = $archive.CreateEntry("BACKUP-MANIFEST.json")
  $stream = $entry.Open()
  $writer = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false))
  try { $writer.Write($manifest) } finally { $writer.Dispose(); $stream.Dispose() }
}
finally {
  $archive.Dispose()
}

$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText(
  "$archivePath.sha256",
  "$hash  $([System.IO.Path]::GetFileName($archivePath))`n",
  [System.Text.UTF8Encoding]::new($false)
)

[pscustomobject]@{
  status = "created"
  archive = $archivePath
  sha256 = $hash
  files = $files.Count
  size_bytes = (Get-Item -LiteralPath $archivePath).Length
}
