const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { elevatedRegistrationCommand } = require('./obs-virtualcam-registration.cjs');

const ps = value => `'${String(value).replace(/'/g, "''")}'`;
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
function runPowerShell(script, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve({ code, output });
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('NETWORK_SETUP_TIMEOUT')); }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', value => { output += value; if (output.length > 65536) { child.kill(); finish(new Error('NETWORK_SETUP_OUTPUT_LIMIT')); } });
    child.once('error', error => finish(error));
    child.once('exit', code => finish(null, code));
  });
}

function permissionRules({ executable, runtimeRoot, dataRoot }) {
  const scope = createHash('sha256').update(path.resolve(executable).toLowerCase()).digest('hex').slice(0, 16);
  const programs = [
    ['app', executable],
    ['media', path.join(runtimeRoot, 'runtime/native-media/RoomcastNativeMedia.exe')],
    ['native-ice', path.join(runtimeRoot, 'runtime/native-ice/RoomcastNativeIce.exe')],
  ];
  const rules = programs.flatMap(([component, program]) => [6, 17].map(protocol => ({
    key: `${component}-${protocol}`, component, program, protocol, action: 1, ports: '*', remote: '*',
  })));
  const obs = path.join(dataRoot, 'runtime/obs-fixed-fps/bin/64bit/obs64.exe');
  // OBS has no loopback-bind setting. Its control client uses IPv4 loopback only.
  // The explicit remote range excludes all of 127/8, so local IPC is unaffected.
  rules.push({ key: 'obs-local', component: 'obs', program: obs, protocol: 6, action: 1, ports: '4457', remote: '127.0.0.0/255.0.0.0' });
  rules.push({ key: 'obs-external', component: 'obs', program: obs, protocol: 6, action: 0, ports: '4457', remote: '0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255' });
  return rules.map(rule => ({ ...rule, name: `Roomcast.Network.v1.${scope}.${rule.key}` }));
}

function definitions(rules) {
  return `$specs = @(${rules.map(rule => `@{name=${ps(rule.name)};component=${ps(rule.component)};program=${ps(rule.program)};protocol=${rule.protocol};action=${rule.action};ports=${ps(rule.ports)};remote=${ps(rule.remote)}}`).join(',')})`;
}

function inspectScript(rules) {
  return `$ErrorActionPreference='Stop'
${definitions(rules)}
$fw=New-Object -ComObject HNetCfg.FwPolicy2
$enabled=@(1,2,4 | Where-Object { $fw.FirewallEnabled($_) })
$policy=[int]$fw.LocalPolicyModifyState
$all=@($fw.Rules)
$states=@(foreach($s in $specs) {
  $r=$all | Where-Object { $_.Name -eq $s.name } | Select-Object -First 1
  $ready=$r -and $r.Enabled -and $r.Direction -eq 1 -and $r.ApplicationName -ieq $s.program -and $r.Protocol -eq $s.protocol -and $r.Action -eq $s.action -and ($r.Profiles -band 7) -eq 7 -and $r.LocalPorts -eq $s.ports -and $r.RemoteAddresses -eq $s.remote
  $blocked=@($all | Where-Object { $_.Enabled -and $_.Direction -eq 1 -and $_.Action -eq 0 -and $_.ApplicationName -ieq $s.program -and $_.Name -notlike 'Roomcast.Network.v1.*' }).Count -gt 0
  @{key=$s.name;component=$s.component;ready=[bool]$ready;blocked=[bool]$blocked}
})
@{enabled=$enabled;policy=$policy;rules=$states} | ConvertTo-Json -Depth 4 -Compress`;
}

function setupScript(rules) {
  // Encoded inline source is passed to RunAs. Never execute an elevated .ps1
  // from a user-writable directory or remove a user/administrator block rule.
  return `${definitions(rules)}
$fw=New-Object -ComObject HNetCfg.FwPolicy2
if ([int]$fw.LocalPolicyModifyState -ne 0) { throw 'NETWORK_POLICY_MANAGED' }
foreach($s in $specs) {
  $blocked=@($fw.Rules | Where-Object { $_.Enabled -and $_.Direction -eq 1 -and $_.Action -eq 0 -and $_.ApplicationName -ieq $s.program -and $_.Name -notlike 'Roomcast.Network.v1.*' }).Count -gt 0
  if ($blocked) { continue }
  $r=New-Object -ComObject HNetCfg.FWRule
  $r.Name=$s.name; $r.Description='Roomcast application network setup v1'
  $r.Grouping='Roomcast application network setup'
  $r.ApplicationName=$s.program; $r.Protocol=$s.protocol
  $r.LocalPorts=$s.ports; $r.RemoteAddresses=$s.remote
  $r.Direction=1; $r.Action=$s.action; $r.Profiles=7; $r.Enabled=$true
  $fw.Rules.Add($r)
}`;
}

function firewallEventsScript(rules, since, runtimeRoot) {
  const observed = [...rules, { name: 'campus', component: 'campus', program: path.join(runtimeRoot, 'runtime/easytier/easytier-core.exe'), protocol: 17, action: 1, ports: '*', remote: '*' }];
  return `${definitions(observed)}
$log='Microsoft-Windows-Windows Firewall With Advanced Security/Firewall'
try {
  $info=Get-WinEvent -ListLog $log -ErrorAction Stop
  $events=@(Get-WinEvent -FilterHashtable @{LogName=$log;Id=2004,2005,2011;StartTime=[datetime]::Parse(${ps(since)})} -MaxEvents 200 -ErrorAction SilentlyContinue)
  $matched=@(foreach($e in $events) {
    $data=@{}; ([xml]$e.ToXml()).Event.EventData.Data | ForEach-Object { $data[$_.Name]=$_.InnerText }
    $component=$specs | Where-Object { $_.program -ieq $data['ApplicationPath'] } | Select-Object -First 1
    if ($component) {
      $kind=switch($e.Id) { 2004 {'rule-added'} 2005 {'rule-modified'} 2011 {'notification-failed'} }
      $item=@{at=$e.TimeCreated.ToUniversalTime().ToString('o');component=$component.component;eventId=$e.Id;kind=$kind}
      if ($e.Id -in 2004,2005) { $item.action=[int]$data['Action'] }
      if ($e.Id -eq 2011) { $item.reasonCode=[int]$data['ReasonCode'] }
      $item
    }
  })
  @{available=[bool]$info.IsEnabled;events=@($matched | Select-Object -First 80)} | ConvertTo-Json -Depth 4 -Compress
} catch { '{"available":false,"events":[]}' }`;
}

function createNetworkPermissions({ app, runtimeRoot }) {
  const dataRoot = app.getPath('userData');
  const rules = permissionRules({ executable: process.execPath, runtimeRoot, dataRoot });
  const receiptPath = path.join(dataRoot, 'network-setup.json');
  const diagnosticPath = path.join(dataRoot, 'network-permissions.json');
  const signature = rules[0].name.replace(/\.app-6$/, '');
  const events = [];
  const startedAt = new Date().toISOString();
  let state = { status: 'not-checked' }, pending = '', attempted = false, installing = null, lastAttempt = null;
  // Keep one previous run for a user who restarts before exporting diagnostics.
  // Never recursively retain its previousRun field.
  let previousRun = null;
  const previousRunReady = fs.readFile(diagnosticPath, 'utf8').then(raw => {
    const previous = JSON.parse(raw);
    if (Array.isArray(previous.events)) previousRun = {
      version: previous.version, startedAt: previous.startedAt, state: previous.state,
      lastAttempt: previous.lastAttempt, events: previous.events.slice(-80),
    };
  }).catch(() => {});
  let write = previousRunReady;
  const diagnostics = () => ({ schema: 2, version: app.getVersion(), startedAt, state, lastAttempt, events: events.slice(), previousRun });
  const record = (component, stage, code = '') => {
    events.push({ at: new Date().toISOString(), component, stage, ...(code ? { code: String(code).slice(0, 48) } : {}) });
    if (events.length > 80) events.shift();
    const snapshot = { ...diagnostics(), previousRun: undefined };
    write = write.then(() => fs.mkdir(dataRoot, { recursive: true }))
      .then(() => fs.writeFile(diagnosticPath, JSON.stringify({ ...snapshot, previousRun }, null, 2))).catch(() => {});
  };
  const inspect = async () => {
    const result = await runPowerShell(inspectScript(rules));
    if (result.code !== 0) throw new Error('NETWORK_INSPECTION_UNAVAILABLE');
    const value = JSON.parse(result.output.replace(/^\uFEFF/, ''));
    const states = Array.isArray(value.rules) ? value.rules : [];
    state = { status: 'checked', enabledProfiles: value.enabled, policy: value.policy,
      components: states.map(({ component, ready, blocked }) => ({ component, ready, blocked })) };
    return value;
  };
  const prepare = async ({ retry = false } = {}) => {
    pending = '';
    if (process.platform !== 'win32' || !app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) {
      state = { status: 'unmanaged-launch' }; record('setup', 'skipped'); return '';
    }
    try {
      const value = await inspect();
      const missing = value.rules.filter(rule => !rule.ready && !rule.blocked);
      if (!value.enabled.length || value.policy !== 0 || !missing.length) {
        state.status = !value.enabled.length ? 'firewall-disabled' : value.policy !== 0 ? 'managed-policy' : 'ready-or-explicitly-blocked';
        record('setup', 'inspected'); return '';
      }
      // A receipt describes an attempt; it never overrides current rule state.
      // Avoid automatic duplicate prompts in this launch, while a deliberate
      // join/share request or the next launch can retry incomplete setup.
      if (attempted && !retry) { state.status = 'retry-on-request'; record('setup', 'deferred'); return ''; }
      pending = setupScript(rules.filter(rule => missing.some(item => item.key === rule.name)));
      record('setup', 'prepared'); return pending;
    } catch { state.status = 'inspection-unavailable'; record('setup', 'skipped'); return ''; }
  };
  const beginAttempt = (stage = 'elevation-requested') => {
    attempted = true;
    lastAttempt = { at: new Date().toISOString(), result: 'started' };
    record('setup', stage);
  };
  const complete = async (mode, code = '') => {
    pending = '';
    try { await inspect(); } catch { state = { status: 'inspection-unavailable' }; }
    lastAttempt = { ...lastAttempt, finishedAt: new Date().toISOString(), result: mode, code: String(code) };
    // This is diagnostic only, including migration from beta.6's sticky marker.
    await fs.mkdir(dataRoot, { recursive: true }).then(() => fs.writeFile(receiptPath,
      JSON.stringify({ signature, ...lastAttempt }))).catch(() => {});
    record('setup', mode, code);
  };
  const install = (options = {}) => {
    if (installing) return installing;
    const task = (async () => {
      const script = pending || await prepare(options);
      if (!script) return;
      beginAttempt();
      try {
        const result = await runPowerShell(elevatedRegistrationCommand(`$ErrorActionPreference='Stop'\n${script}\nexit 0`), 180000);
        await complete(result.code === 0 ? 'completed' : result.code === 1223 ? 'cancelled' : 'failed', result.code);
      } catch { await complete('failed'); }
    })();
    installing = task;
    return task.finally(() => { if (installing === task) installing = null; });
  };
  const collectDiagnostics = async () => {
    try { await inspect(); } catch { }
    let systemEvents = { available: false, events: [] };
    try {
      const result = await runPowerShell(firewallEventsScript(rules, startedAt, runtimeRoot));
      if (result.code === 0) systemEvents = JSON.parse(result.output.replace(/^\uFEFF/, ''));
    } catch { }
    await previousRunReady;
    // Rule changes and notification failures are not proof a dialog was shown.
    return { ...diagnostics(), systemEvents: { ...systemEvents, confirmsVisiblePrompt: false } };
  };
  return { prepare, install, beginAttempt, complete, record, diagnostics, collectDiagnostics };
}

module.exports = { createNetworkPermissions, permissionRules, inspectScript, setupScript, firewallEventsScript };
