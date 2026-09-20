[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Endpoint,

  [Parameter(Mandatory = $true)]
  [string]$CodeSigningAccountName,

  [Parameter(Mandatory = $true)]
  [string]$CertificateProfileName,

  [string]$PublisherName = 'D4Y0',

  [string]$FileDigest = 'SHA256',

  [string]$TimestampRfc3161 = 'http://timestamp.acs.microsoft.com',

  [string]$TimestampDigest = 'SHA256',

  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $root 'package.json'

if (-not (Test-Path -LiteralPath $packagePath)) {
  throw "package.json not found: $packagePath"
}

$config = [ordered]@{
  publisherName          = $PublisherName
  endpoint               = $Endpoint
  certificateProfileName = $CertificateProfileName
  codeSigningAccountName = $CodeSigningAccountName
  fileDigest             = $FileDigest
  timestampRfc3161       = $TimestampRfc3161
  timestampDigest        = $TimestampDigest
}

if ($DryRun) {
  Write-Host 'DryRun: azureSignOptions to apply:'
  $config | ConvertTo-Json -Depth 6
  return
}

$backupPath = "$packagePath.azure-signing.bak"
Copy-Item -LiteralPath $packagePath -Destination $backupPath -Force

$env:ROOMCAST_AZURE_SIGNING_CONFIG = ($config | ConvertTo-Json -Compress)
$nodeHelper = Join-Path $PSScriptRoot 'Update-PackageJson-AzureSigning.cjs'

& node $nodeHelper $packagePath
$exitCode = $LASTEXITCODE

Remove-Item Env:\ROOMCAST_AZURE_SIGNING_CONFIG -ErrorAction SilentlyContinue

if ($exitCode -ne 0) {
  throw "Failed to update package.json. Backup kept at: $backupPath"
}

Write-Host 'Updated package.json:'
Write-Host "  build.win.signExecutable = true"
Write-Host "  build.win.azureSignOptions.endpoint = $Endpoint"
Write-Host "  build.win.azureSignOptions.codeSigningAccountName = $CodeSigningAccountName"
Write-Host "  build.win.azureSignOptions.certificateProfileName = $CertificateProfileName"
Write-Host "  build.win.azureSignOptions.publisherName = $PublisherName"
Write-Host "Backup: $backupPath"