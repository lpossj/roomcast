[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PfxPath,

  [Parameter(Mandatory = $true)]
  [string]$Password,

  [string]$Version = '',

  [switch]$Timestamp
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $Version) {
  $packagePath = Join-Path $root 'package.json'
  $Version = (Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version
}

if (-not (Test-Path -LiteralPath $PfxPath)) {
  throw "PFX not found: $PfxPath"
}

function Find-SignTool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $bases = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'),
    (Join-Path $env:ProgramFiles 'Windows Kits\10\bin')
  )

  foreach ($base in $bases) {
    if (-not (Test-Path -LiteralPath $base)) {
      continue
    }

    $versions = Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending

    foreach ($versionDir in $versions) {
      $candidate = Join-Path $versionDir.FullName 'x64\signtool.exe'
      if (Test-Path -LiteralPath $candidate) {
        return $candidate
      }
    }
  }

  return $null
}

$signtool = Find-SignTool
if (-not $signtool) {
  throw 'signtool.exe not found. Install Windows SDK or Trusted Signing Client Tools.'
}

$targets = @(
  (Join-Path $root "release\Roomcast-$Version-Windows.exe"),
  (Join-Path $root 'release\win-unpacked\Roomcast.exe')
)

$signed = 0

foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target)) {
    Write-Warning "Not found, skipped: $target"
    continue
  }

  Write-Host "Signing: $target"
  $arguments = @(
    'sign',
    '/fd', 'SHA256',
    '/f', (Resolve-Path -LiteralPath $PfxPath).Path,
    '/p', $Password,
    '/a'
  )

  if ($Timestamp) {
    $arguments += @('/tr', 'http://timestamp.digicert.com', '/td', 'SHA256')
  }

  $arguments += $target

  & $signtool @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "signtool failed for: $target"
  }

  $signed++
}

if ($signed -eq 0) {
  throw "No release EXE found for version $Version"
}

$zipPath = Join-Path $root "release\Roomcast-$Version-Windows.zip"
if (Test-Path -LiteralPath $zipPath) {
  Write-Warning "ZIP already exists. If you signed win-unpacked\Roomcast.exe after creating the ZIP, rebuild the ZIP so it contains the signed executable."
}

Write-Host "Signed files: $signed"