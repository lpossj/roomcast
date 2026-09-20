[CmdletBinding()]
param(
  [string]$PfxPath = '',

  [Parameter(Mandatory = $true)]
  [string]$Password
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $PfxPath) {
  $PfxPath = Join-Path $root 'build-assets\D4Y0-roomcast-selfsigned.pfx'
}

if (-not (Test-Path -LiteralPath $PfxPath)) {
  throw "PFX not found: $PfxPath. Run New-RoomcastSelfSignedCert.ps1 first."
}

$resolvedPfx = (Resolve-Path -LiteralPath $PfxPath).Path
$packagePath = Join-Path $root 'package.json'
$backupPath = "$packagePath.self-signed.bak"

Copy-Item -LiteralPath $packagePath -Destination $backupPath -Force

$helper = Join-Path $PSScriptRoot 'Update-PackageJson-SignExecutable.cjs'
& node $helper $packagePath
if ($LASTEXITCODE -ne 0) {
  throw "Failed to update package.json. Backup: $backupPath"
}

$env:CSC_LINK = $resolvedPfx
$env:CSC_KEY_PASSWORD = $Password
$env:WIN_CSC_LINK = $resolvedPfx
$env:WIN_CSC_KEY_PASSWORD = $Password

Write-Host 'Self-signed signing is enabled for this PowerShell session:'
Write-Host "  CSC_LINK = $resolvedPfx"
Write-Host "  package.json signExecutable = true"
Write-Host "Backup: $backupPath"
Write-Host ''
Write-Host 'Run packaging:'
Write-Host '  npm.cmd run dist:obs-verified'