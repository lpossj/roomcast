[CmdletBinding()]
param(
  [string]$Subject = 'CN=D4Y0',

  [string]$FriendlyName = 'D4Y0 Roomcast Self-Signed Code Signing',

  [string]$OutFile = '',

  [int]$Years = 3
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $OutFile) {
  $OutFile = Join-Path $root 'build-assets\D4Y0-roomcast-selfsigned.pfx'
}

$outDir = Split-Path -Parent $OutFile
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$plainPassword = Read-Host "Please enter PFX password"
$securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force

Write-Host "Creating self-signed code signing certificate..."
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $Subject `
  -FriendlyName $FriendlyName `
  -CertStoreLocation Cert:\CurrentUser\My `
  -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature `
  -NotAfter (Get-Date).AddYears($Years)

Export-PfxCertificate `
  -Cert $cert `
  -FilePath $OutFile `
  -Password $securePassword | Out-Null

Write-Host "PFX created: $OutFile"
Write-Host "Subject:     $($cert.Subject)"
Write-Host "Thumbprint:  $($cert.Thumbprint)"
Write-Host ""
Write-Host "This certificate is self-signed. Windows will NOT trust it."