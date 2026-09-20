[CmdletBinding()]
param(
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $Version) {
  $packagePath = Join-Path $root 'package.json'
  $Version = (Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version
}

$releaseDir = Join-Path $root 'release'
$targets = @(
  (Join-Path $releaseDir "Roomcast-$Version-Windows.exe"),
  (Join-Path $releaseDir 'win-unpacked\Roomcast.exe')
)

$checked = 0

foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target)) {
    Write-Warning "Not found, skipped: $target"
    continue
  }

  $checked++
  Write-Host ''
  Write-Host "=== $target ==="
  Get-AuthenticodeSignature -LiteralPath $target |
    Format-List Status, StatusMessage, SignerCertificate
}

if ($checked -eq 0) {
  throw "No release executable found for version $Version"
}