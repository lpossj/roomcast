param(
  [Parameter(Mandatory=$true)][string]$SessionDirectory,
  [Parameter(Mandatory=$true)][string]$RuntimeDirectory,
  [Parameter(Mandatory=$true)][int]$ParentId,
  [Parameter(Mandatory=$true)][long]$ParentCreated,
  [Parameter(Mandatory=$true)][string]$ProgramPath,
  [Parameter(Mandatory=$true)][string]$DeviceName,
  [Parameter(Mandatory=$true)][string]$CoreHash,
  [Parameter(Mandatory=$true)][string]$DriverHash,
  [Parameter(Mandatory=$true)][string]$ConfigHash
)
$ErrorActionPreference = 'Stop'
$job = $null
$locks = @()
$rules = @()
$stopPath = Join-Path $SessionDirectory 'stop'
$stage = 'identity'
function Write-StartupStatus([string]$FileName, [string]$Step, $Failure) {
  # Only a fixed stage and numeric OS code cross the elevated boundary.
  $code = 0
  $exception = $Failure.Exception
  while ($exception.InnerException) { $exception = $exception.InnerException }
  if ($exception -is [ComponentModel.Win32Exception]) { $code = $exception.NativeErrorCode }
  elseif ($exception) { $code = $exception.HResult }
  try {
    $value = @{ stage = $Step; code = $code } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $SessionDirectory $FileName), $value)
  } catch { }
}
try {
  if ($DeviceName -notmatch '^Roomcast-[a-f0-9]{8}$') { throw 'Invalid device' }
  if (Test-Path -LiteralPath $stopPath) { return }
  # Do not let inherited CLI environment override the room's restricted config.
  Get-ChildItem Env: | Where-Object { $_.Name -like 'ET_*' } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
  $parent = [Diagnostics.Process]::GetProcessById($ParentId)
  $created = ([DateTimeOffset]$parent.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
  if ([Math]::Abs($created - $ParentCreated) -gt 5000) { throw 'Parent identity changed' }
  if ([IO.Path]::GetFullPath($parent.MainModule.FileName) -ne [IO.Path]::GetFullPath($ProgramPath)) { throw 'Parent path changed' }
  $corePath = Join-Path $RuntimeDirectory 'easytier-core.exe'
  $configPath = Join-Path $SessionDirectory 'network.toml'
  $stage = 'integrity'
  foreach ($item in @(@($corePath,$CoreHash),@((Join-Path $RuntimeDirectory 'wintun.dll'),$DriverHash),@($configPath,$ConfigHash))) {
    $cursor = [IO.Path]::GetFullPath($item[0])
    while ($cursor) {
      if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused' }
      $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    # Hold read-only sharing handles through shutdown: refuse a replacement
    # between the integrity decision and elevated process/DLL loading.
    $handle = [IO.File]::Open($item[0], [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $locks += $handle
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($sha.ComputeHash($handle))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($actual -ne $item[1]) { throw 'Component changed' }
  }
  $stage = 'compile'
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public sealed class CampusJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long UserTime, JobTime; public uint Flags; public UIntPtr Min, Max; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASIC Basic; public IO Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct START { public uint cb; public string Reserved, Desktop, Title; public uint X,Y,XS,YS,XC,YC,Fill,Flags; public ushort Show,ReservedSize; public IntPtr Reserved2,In,Out,Err; }
  [StructLayout(LayoutKind.Sequential)] struct INFO { public IntPtr Process, Thread; public uint Id, ThreadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,ref LIMIT l,uint n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref START si,out INFO pi);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  IntPtr job,process;
  public CampusJob(string exe,string config,string cwd) {
    job=CreateJobObject(IntPtr.Zero,null);
    if(job==IntPtr.Zero) throw new Win32Exception();
    LIMIT limit=new LIMIT(); limit.Basic.Flags=0x2000;
    if(!SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(typeof(LIMIT)))) { Dispose(); throw new Win32Exception(); }
    START start=new START(); start.cb=(uint)Marshal.SizeOf(typeof(START)); INFO info;
    var args=new StringBuilder("\""+exe+"\" --config-file \""+config+"\" --console-log-level off");
    if(!CreateProcess(exe,args,IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,cwd,ref start,out info)) { Dispose(); throw new Win32Exception(); }
    process=info.Process;
    try {
      if(!AssignProcessToJobObject(job,process)) throw new Win32Exception();
      if(ResumeThread(info.Thread)==UInt32.MaxValue) throw new Win32Exception();
    } catch { TerminateProcess(process,1); Dispose(); throw; }
    finally { CloseHandle(info.Thread); }
  }
  public bool Running { get { return process!=IntPtr.Zero && WaitForSingleObject(process,0)==258; } }
  public void Dispose() { if(job!=IntPtr.Zero){ CloseHandle(job); job=IntPtr.Zero; } if(process!=IntPtr.Zero){ CloseHandle(process); process=IntPtr.Zero; } }
}
'@
  if (Test-Path -LiteralPath $stopPath) { return }
  $group = 'Roomcast-Campus-' + [Guid]::NewGuid().ToString('N')
  foreach ($protocol in @('UDP','TCP')) {
    $ruleName = "$group-Core-$protocol"
    $rules += $ruleName
    try {
      New-NetFirewallRule -Name $ruleName -DisplayName 'Roomcast 校园互联核心（临时）' -Group $group -Program $corePath -Direction Inbound -Action Allow -Protocol $protocol -Profile Any | Out-Null
    } catch { Write-StartupStatus 'firewall-warning' 'firewall-core' $_ }
  }
  $stage = 'core-start'
  $job = New-Object CampusJob($corePath, $configPath, $RuntimeDirectory)
  $stage = 'adapter-wait'
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  # Use the IP Helper-backed API instead of making NetAdapter/CIM availability
  # a prerequisite for an otherwise usable Wintun interface.
  while (-not ([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.Name -eq $DeviceName })) {
    if (-not $job.Running -or $parent.HasExited -or (Test-Path -LiteralPath $stopPath) -or [DateTime]::UtcNow -gt $deadline) { throw 'Adapter unavailable' }
    Start-Sleep -Milliseconds 250
  }
  $mediaRule = "$group-Media"
  $rules += $mediaRule
  try {
    New-NetFirewallRule -Name $mediaRule -DisplayName 'Roomcast 校园媒体（临时）' -Group $group -Program $ProgramPath -InterfaceAlias $DeviceName -Direction Inbound -Action Allow -Protocol UDP -LocalPort '50000-50255' -Profile Any | Out-Null
  } catch { Write-StartupStatus 'firewall-warning' 'firewall-media' $_ }
  $stage = 'ready'
  [IO.File]::WriteAllText((Join-Path $SessionDirectory 'ready'), 'ready')
  $stage = 'running'
  while ($job.Running -and -not $parent.HasExited -and -not (Test-Path -LiteralPath $stopPath)) { Start-Sleep -Milliseconds 300; $parent.Refresh() }
} catch {
  # No raw command line, secret, address or exception text crosses into the UI.
  Write-StartupStatus 'failed' $stage $_
} finally {
  if ($job) { try { $job.Dispose() } catch { } }
  foreach ($name in $rules) { try { Remove-NetFirewallRule -Name $name -ErrorAction Stop } catch { } }
  foreach ($handle in $locks) { try { $handle.Dispose() } catch { } }
  try { Remove-Item -LiteralPath (Join-Path $SessionDirectory 'network.toml') -Force -ErrorAction Stop } catch { }
}
