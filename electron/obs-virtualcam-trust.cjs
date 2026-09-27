// Pinned from the SHA-256 verified official OBS 32.1.2 Windows archive.
// Markers and runtime manifests are cache metadata, never trust inputs.
const VIRTUALCAM_HASHES = Object.freeze({
  32: '9fc2de9d69e33138cb3b00c85f4461f6070aeaa1a3b10e7fd13aa6c184646150',
  64: '008f808f8f4306ef9ec2cac4d22745ac063686e47d3c24eda16fce6da1197c89',
});

function virtualCameraTrustScript() {
  return `
function Assert-NoReparse([string]$Path) {
  $Full = [System.IO.Path]::GetFullPath($Path)
  if ($Full -notmatch '^[A-Za-z]:\\\\' -or $Full.Substring(2).Contains(':')) { throw 'DLL path must be a local filesystem path' }
  $ItemPath = $Full
  while ($ItemPath) {
    if (Test-Path -LiteralPath $ItemPath) {
      $Item = Get-Item -LiteralPath $ItemPath -Force -ErrorAction Stop
      if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point is not allowed' }
    }
    $ItemPath = Split-Path -Parent $ItemPath
  }
}
function Open-VerifiedDll([string]$Path, [string]$Expected) {
  Assert-NoReparse $Path
  $Stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    Assert-NoReparse $Path
    $Sha = [System.Security.Cryptography.SHA256]::Create()
    try { $Actual = [BitConverter]::ToString($Sha.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() } finally { $Sha.Dispose() }
    if ($Actual -ne $Expected) { throw 'Virtual Camera DLL SHA-256 mismatch' }
    $Stream.Position = 0
    return $Stream
  } catch { $Stream.Dispose(); throw }
}
function Protect-InstallDirectory([string]$Path) {
  Assert-NoReparse $Path
  $Acl = New-Object System.Security.AccessControl.DirectorySecurity
  $Admins = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
  $System = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
  $Users = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545')
  $Acl.SetOwner($Admins)
  $Acl.SetAccessRuleProtection($true, $false)
  foreach ($Sid in @($Admins, $System)) {
    $Acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($Sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  $Acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($Users, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  if (-not (Test-Path -LiteralPath $Path)) { [System.IO.Directory]::CreateDirectory($Path, $Acl) | Out-Null }
  else { Set-Acl -LiteralPath $Path -AclObject $Acl -ErrorAction Stop }
  Assert-NoReparse $Path
}
function Copy-VerifiedDll([string]$Source, [string]$Target, [string]$Expected) {
  $SourceStream = Open-VerifiedDll $Source $Expected
  try {
    Assert-NoReparse $Target
    # Do not preserve a previously user-writable target's ACL or hardlink.
    if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Force -ErrorAction Stop }
    $Output = [System.IO.File]::Open($Target, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $SourceStream.CopyTo($Output) } finally { $Output.Dispose() }
    # Keep this verified target handle open through regsvr32; no write/delete sharing.
    return (Open-VerifiedDll $Target $Expected)
  } finally { $SourceStream.Dispose() }
}
`;
}

module.exports = { VIRTUALCAM_HASHES, virtualCameraTrustScript };
