const { execFile } = require('node:child_process');
const path = require('node:path');

const OWN_PROCESS = /^(?:roomcast|electron)(?:\.exe)?$/i;
const SHELL_PROCESS = /^(?:explorer|sihost|taskhostw|services|svchost|wininit|winlogon)(?:\.exe)?$/i;

function cleanText(value, limit = 180) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
}

function processName(value) {
  return path.win32.basename(cleanText(value, 260)).toLowerCase();
}

function isOwnProcess(item) {
  const values = [item?.processName, item?.ProcessName, item?.Name, item?.ExecutablePath, item?.Path];
  return values.some(value => OWN_PROCESS.test(path.win32.basename(cleanText(value, 260))));
}

// Windows has no supported command-line API for enumerating active audio
// sessions. This fixed script uses the documented Core Audio COM interfaces;
// renderer input is never interpolated into it.
const AUDIO_SESSION_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RoomcastAudioSessions {
  enum EDataFlow { eRender, eCapture, eAll }
  enum ERole { eConsole, eMultimedia, eCommunications }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(EDataFlow f, int mask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow f, ERole r, out IMMDevice device);
  }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E")]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IMMDevice device);
  }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsctx, IntPtr activation, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
  }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr id, int flags, out object control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr id, int flags, out object volume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl control);
  }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
  interface IAudioSessionControl {}
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state); [PreserveSig] int GetDisplayName(out IntPtr name); [PreserveSig] int SetDisplayName(IntPtr name, ref Guid ctx);
    [PreserveSig] int GetIconPath(out IntPtr path); [PreserveSig] int SetIconPath(IntPtr path, ref Guid ctx); [PreserveSig] int GetGroupingParam(out Guid group);
    [PreserveSig] int SetGroupingParam(ref Guid group, ref Guid ctx); [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client); [PreserveSig] int GetSessionIdentifier(out IntPtr id);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id); [PreserveSig] int GetProcessId(out uint processId);
  }
  public static uint[] List() {
    var result = new HashSet<uint>();
    var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDeviceCollection devices = null;
    try {
      Marshal.ThrowExceptionForHR(enumerator.EnumAudioEndpoints(EDataFlow.eRender, 1, out devices));
      uint deviceCount; Marshal.ThrowExceptionForHR(devices.GetCount(out deviceCount));
      for (uint d=0; d<deviceCount; d++) {
        IMMDevice device = null; object instance = null; IAudioSessionEnumerator sessions = null;
        try {
          Marshal.ThrowExceptionForHR(devices.Item(d, out device));
          Guid iid = typeof(IAudioSessionManager2).GUID;
          Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out instance));
          Marshal.ThrowExceptionForHR(((IAudioSessionManager2)instance).GetSessionEnumerator(out sessions));
          int count; Marshal.ThrowExceptionForHR(sessions.GetCount(out count));
          for (int i=0; i<count; i++) {
            IAudioSessionControl control = null;
            try {
              Marshal.ThrowExceptionForHR(sessions.GetSession(i, out control));
              var control2 = (IAudioSessionControl2)control; uint pid;
              Marshal.ThrowExceptionForHR(control2.GetProcessId(out pid));
              if (pid > 0) result.Add(pid);
            } finally { if (control != null) Marshal.ReleaseComObject(control); }
          }
        } finally {
          if (sessions != null) Marshal.ReleaseComObject(sessions);
          if (instance != null) Marshal.ReleaseComObject(instance);
          if (device != null) Marshal.ReleaseComObject(device);
        }
      }
    } finally {
      if (devices != null) Marshal.ReleaseComObject(devices);
      Marshal.ReleaseComObject(enumerator);
    }
    return new List<uint>(result).ToArray();
  }
}
'@
$audio=@([RoomcastAudioSessions]::List())
if ($audio.Count -eq 0) {
  @{ AudioProcessIds=@(); Processes=@() } | ConvertTo-Json -Compress -Depth 4
  exit 0
}
# Build the process tree once, then keep only active audio-session processes and
# their ancestors. Friendly names are read only for this small relevant set.
$all=@(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate -ErrorAction Stop)
$byPid=@{}
foreach ($row in $all) { $byPid[[int]$row.ProcessId]=$row }
$needed=New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($rawAudioId in $audio) {
  $currentId=[int]$rawAudioId
  $guard=0
  while ($currentId -gt 0 -and $guard -lt 16 -and $byPid.ContainsKey($currentId)) {
    if (-not $needed.Add($currentId)) { break }
    $nextId=[int]$byPid[$currentId].ParentProcessId
    if ($nextId -le 0 -or $nextId -eq $currentId) { break }
    $currentId=$nextId
    $guard++
  }
}
$processRows=@($needed | ForEach-Object {
  $processIdValue=[int]$_
  $row=$byPid[$processIdValue]
  $description=''
  $title=''
  if ($row.ExecutablePath) {
    try { $description=[Diagnostics.FileVersionInfo]::GetVersionInfo([string]$row.ExecutablePath).FileDescription } catch {}
  }
  try { $title=(Get-Process -Id $processIdValue -ErrorAction Stop).MainWindowTitle } catch {}
  @{ Id=$processIdValue; ParentId=[int]$row.ParentProcessId; Name=[string]$row.Name; Path=[string]$row.ExecutablePath; Title=[string]$title; Description=[string]$description; StartedAt=if ($row.CreationDate) { $row.CreationDate.ToUniversalTime().Ticks.ToString() } else { '' } }
})
@{ AudioProcessIds=@($audio); Processes=@($processRows) } | ConvertTo-Json -Compress -Depth 4
`;

function rootApplication(row, table) {
  let current = row;
  const visited = new Set([Number(row.Id)]);
  while (current) {
    const parent = table.get(Number(current.ParentId));
    if (!parent || visited.has(Number(parent.Id)) || SHELL_PROCESS.test(processName(parent.Name))) break;
    if (parent.StartedAt && current.StartedAt && BigInt(parent.StartedAt) > BigInt(current.StartedAt)) break;
    const sameName = processName(parent.Name) === processName(current.Name);
    const currentDir = current.Path ? path.win32.dirname(current.Path).toLowerCase() : '';
    const parentDir = parent.Path ? path.win32.dirname(parent.Path).toLowerCase() : '';
    if (!sameName && (!currentDir || currentDir !== parentDir)) break;
    current = parent;
    visited.add(Number(current.Id));
  }
  return current;
}

function normalizeAudioInventory(value) {
  const processes = Array.isArray(value?.Processes) ? value.Processes : value?.Processes ? [value.Processes] : [];
  const table = new Map(processes.filter(item => Number(item?.Id) > 0).map(item => [Number(item.Id), item]));
  const audioIds = Array.isArray(value?.AudioProcessIds) ? value.AudioProcessIds : value?.AudioProcessIds ? [value.AudioProcessIds] : [];
  const applications = new Map();
  for (const rawId of audioIds) {
    const session = table.get(Number(rawId));
    if (!session) continue;
    const root = rootApplication(session, table);
    if (isOwnProcess(session) || isOwnProcess(root)) continue;
    const rawExecutable = path.win32.basename(cleanText(root.Name || session.Name, 260));
    const executable = rawExecutable.toLowerCase();
    if (!executable || SHELL_PROCESS.test(executable)) continue;
    const key = String(root.Id);
    const title = cleanText(root.Title || session.Title, 180);
    const description = cleanText(root.Description || session.Description, 100);
    const executableLabel = /\.exe$/i.test(rawExecutable) ? rawExecutable : `${rawExecutable}.exe`;
    const fallbackName = executableLabel.replace(/\.exe$/i, '');
    const normalizedFallback = fallbackName.toLowerCase();
    const usefulDescription = description && ![normalizedFallback, executableLabel.toLowerCase()].includes(description.toLowerCase());
    const usefulTitle = title && ![normalizedFallback, executableLabel.toLowerCase()].includes(title.toLowerCase());
    const display = usefulDescription ? description : usefulTitle ? title : fallbackName;
    const previous = applications.get(key);
    const item = {
      processId: String(Number(root.Id)),
      processName: executableLabel,
      title,
      name: display,
      sessionProcessIds: [...new Set([...(previous?.sessionProcessIds || []), String(Number(session.Id))])],
    };
    applications.set(key, previous?.title ? { ...item, title: previous.title, name: previous.name } : item);
  }
  return [...applications.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN')).slice(0, 256);
}

function enumerateWindowsAudioSources(execFileImpl) {
  return new Promise((resolve, reject) => execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-MTA', '-Command', AUDIO_SESSION_SCRIPT], { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) return reject(new Error(`音频应用枚举失败：${error.killed ? '等待 Windows 音频会话超时' : cleanText(stderr || error.message, 500)}`));
    try {
      const inventory = JSON.parse(stdout);
      if (!Array.isArray(inventory.AudioProcessIds) || !Array.isArray(inventory.Processes)) throw new Error('Windows 音频会话返回格式无效');
      resolve(normalizeAudioInventory(inventory));
    } catch (failure) { reject(new Error(`音频应用枚举失败：${cleanText(failure.message, 180)}`)); }
  }));
}

function windowsAudioSources(execFileImpl = execFile) {
  return enumerateWindowsAudioSources(execFileImpl);
}

function normalizeCaptureSources(sources = []) {
  const result = new Map();
  for (const item of sources) {
    const id = cleanText(item?.id, 4096);
    const name = cleanText(item?.name, 240);
    if (!id || !name || /(?:同屏\s*Roomcast|Roomcast)/i.test(name)) continue;
    const type = id.startsWith('screen:') ? 'monitor' : id.startsWith('window:') ? 'window' : '';
    if (!type || result.has(id)) continue;
    result.set(id, { id, name, type });
  }
  return [...result.values()];
}

module.exports = { AUDIO_SESSION_SCRIPT, cleanText, isOwnProcess, normalizeAudioInventory, normalizeCaptureSources, windowsAudioSources };
