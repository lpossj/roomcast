[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host '=== Azure Trusted Signing prerequisites ==='

# Azure CLI
$az = Get-Command az -ErrorAction SilentlyContinue
if ($az) {
  Write-Host "Azure CLI: $($az.Source)"
  try {
    $account = az account show --output json 2>$null | ConvertFrom-Json
    if ($account) {
      Write-Host "Signed in: $($account.user.name) / tenant $($account.tenantId)"
    }
  }
  catch {
    Write-Warning 'az found but not signed in. Run: az login'
  }
}
else {
  Write-Warning 'Azure CLI (az) not found.'
}

# TrustedSigning PowerShell module
$module = Get-Module -ListAvailable TrustedSigning |
  Sort-Object Version -Descending |
  Select-Object -First 1

if ($module) {
  Write-Host "TrustedSigning module: $($module.Version)"
}
else {
  Write-Warning 'TrustedSigning module not installed. Run: Install-Module TrustedSigning -MinimumVersion 0.5.0 -Scope CurrentUser -Force'
}

# package.json configuration
$packageJson = Join-Path $root 'package.json'
$pkg = Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json
$win = $pkg.build.win

if ($win.azureSignOptions) {
  Write-Host 'package.json build.win.azureSignOptions:'
  $win.azureSignOptions | ConvertTo-Json -Depth 6
}
else {
  Write-Warning 'package.json build.win.azureSignOptions is not configured.'
}

# CI authentication variables
foreach ($name in @('AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET')) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value) {
    Write-Host "$name = set"
  }
  else {
    Write-Host "$name = not set"
  }
}