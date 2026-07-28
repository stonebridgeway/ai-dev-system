[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Archive,
  [Parameter(Mandatory = $true)]
  [string]$TargetRoot,
  [switch]$AllowNonEmpty,
  [switch]$ConfirmRestore
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not $ConfirmRestore) {
  throw "Restore is blocked until -ConfirmRestore is supplied."
}
$archivePath = (Resolve-Path -LiteralPath $Archive).Path
$target = [System.IO.Path]::GetFullPath($TargetRoot)
if (-not $archivePath.EndsWith(".zip", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Archive must be a .zip file."
}

[System.IO.Directory]::CreateDirectory($target) | Out-Null
$existing = Get-ChildItem -LiteralPath $target -Force | Select-Object -First 1
if ($existing -and -not $AllowNonEmpty) {
  throw "TargetRoot is not empty. Use a fresh directory or explicitly pass -AllowNonEmpty."
}

$zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  if (-not ($zip.Entries | Where-Object FullName -eq "BACKUP-MANIFEST.json")) {
    throw "Backup manifest is missing."
  }
  $targetPrefix = $target.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
  foreach ($entry in $zip.Entries) {
    $entryTarget = [System.IO.Path]::GetFullPath((Join-Path $target $entry.FullName))
    if (-not $entryTarget.StartsWith($targetPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Archive entry escapes TargetRoot: $($entry.FullName)"
    }
    if (-not $entry.Name) {
      [System.IO.Directory]::CreateDirectory($entryTarget) | Out-Null
      continue
    }
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($entryTarget)) | Out-Null
    if ((Test-Path -LiteralPath $entryTarget) -and -not $AllowNonEmpty) {
      throw "Restore would overwrite an existing file: $entryTarget"
    }
    $sourceStream = $entry.Open()
    $targetStream = [System.IO.File]::Open(
      $entryTarget,
      [System.IO.FileMode]::Create,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None
    )
    try { $sourceStream.CopyTo($targetStream) }
    finally { $targetStream.Dispose(); $sourceStream.Dispose() }
  }
}
finally {
  $zip.Dispose()
}
foreach ($required in @(
  "01-system\AI Dev Control Center.md",
  "03-skills-catalog\registries\skills.index.json",
  "09-mcp\ai-dev-mcp-server\package.json"
)) {
  if (-not (Test-Path -LiteralPath (Join-Path $target $required))) {
    throw "Restored backup is incomplete; missing $required"
  }
}

[pscustomobject]@{
  status = "restored"
  archive = $archivePath
  target = $target
}
