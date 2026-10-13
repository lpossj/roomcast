const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { PORTS, LEASE, campusRequest, campusConfig } = require('./campus-policy.cjs');
const { createCampusAdapter } = require('./campus-adapter.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const psString = text => `'${String(text).replace(/'/g, "''")}'`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ipv4Number = address => address.split('.').reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function privateDirectory(directory) {
  const command = `$ErrorActionPreference='Stop'; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')) { $identity=New-Object Security.Principal.SecurityIdentifier($sid); $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule) }; Set-Acl -LiteralPath ${psString(directory)} -AclObject $acl`;
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('无法保护校园互联配置目录。')));
  });
}

function createCampusNetwork({ app, onActive }) {
  let current = null;
  const stop = async lease => {
    if (!current || (lease && lease !== current.lease)) return;
    const session = current;
    current = null;
    session.cancelled = true;
    clearInterval(session.monitor);
    onActive(null);
    await session.adapter?.stop().catch(() => {});
    if (session.directory) await fs.writeFile(path.join(session.directory, 'stop'), '').catch(() => {});
    if (session.directory && (!session.launcher || session.exited)) await fs.unlink(path.join(session.directory, 'network.toml')).catch(() => {});
    // The elevated supervisor owns the job and rules, and observes this marker
    // even when UAC completes after the renderer has already cancelled joining.
  };
  const start = async payload => {
    const value = campusRequest(payload);
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('校园互联目前支持 Windows x64 桌面端。');
    if (current) throw new Error('上一场校园互联尚未结束，请先离开房间。');
    const session = { ...value, cancelled: false, directory: '' };
    current = session;
    try {
      const runtime = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'easytier') : path.join(app.getAppPath(), 'runtime', 'easytier');
      // Expected digests live inside app.asar, separately from executable resources.
      const manifest = JSON.parse(await fs.readFile(path.join(app.getAppPath(), 'electron/campus-runtime-manifest.json'), 'utf8').catch(() => { throw new Error('内置校园互联组件缺失，请使用包含组件的完整版本。'); }));
      for (const name of ['easytier-core.exe', 'wintun.dll', 'campus-supervisor.ps1']) {
        const target = path.join(runtime, name);
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(manifest.files?.[name] || '') || hash(await fs.readFile(target)) !== manifest.files[name]) {
          throw new Error('校园互联组件已损坏，请重新安装完整版本。');
        }
      }
      const subnet = ipv4Number(`${value.prefix}.0`);
      for (const entries of Object.values(os.networkInterfaces())) for (const item of entries || []) {
        if (item.family !== 'IPv4' || item.internal) continue;
        const mask = ipv4Number(item.netmask);
        const sharedMask = mask & 0xffffff00;
        if ((subnet & sharedMask) === (ipv4Number(item.address) & sharedMask)) throw new Error('校园互联地址与本机已有网络冲突，请创建一个新房间。');
      }
      if (session.cancelled) throw new Error('校园互联已取消。');
      const root = path.join(app.getPath('userData'), 'campus-sessions');
      await fs.mkdir(root, { recursive: true });
      session.directory = await fs.mkdtemp(path.join(root, 'session-'));
      // Restrict the request to the current account, SYSTEM and administrators.
      await privateDirectory(session.directory);
      const config = campusConfig(value);
      await fs.writeFile(path.join(session.directory, 'network.toml'), config, { mode: 0o600, flag: 'wx' });
      if (session.cancelled) { await fs.writeFile(path.join(session.directory, 'stop'), ''); throw new Error('校园互联已取消。'); }
      const args = [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `"${path.join(runtime, 'campus-supervisor.ps1')}"`,
        '-SessionDirectory', `"${session.directory}"`, '-RuntimeDirectory', `"${runtime}"`,
        '-ParentId', String(process.pid), '-ParentCreated', String(Math.round(process.getCreationTime?.() || Date.now() - process.uptime() * 1000)),
        '-ProgramPath', `"${process.execPath}"`, '-DeviceName', value.device,
        '-CoreHash', manifest.files['easytier-core.exe'], '-DriverHash', manifest.files['wintun.dll'], '-ConfigHash', hash(Buffer.from(config)),
      ];
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const supervisor = path.join(runtime, 'campus-supervisor.ps1');
      // The non-elevated launcher holds this handle until the elevated helper
      // exits. Hashing and denying write/delete sharing closes the script race.
      const command = `$ErrorActionPreference='Stop'; $handle=$null; $sha=$null; try {
        $cursor=${psString(supervisor)};
        while($cursor) { if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused' }; $cursor=[IO.Path]::GetDirectoryName($cursor) };
        $handle=[IO.File]::Open(${psString(supervisor)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);
        $sha=[Security.Cryptography.SHA256]::Create();
        $actual=([BitConverter]::ToString($sha.ComputeHash($handle))).Replace('-','').ToLowerInvariant();
        if($actual -ne ${psString(manifest.files['campus-supervisor.ps1'])}) { throw 'Supervisor changed' };
        $p=Start-Process -FilePath ${psString(ps)} -Verb RunAs -WindowStyle Hidden -ArgumentList @(${args.map(psString).join(',')}) -PassThru -Wait; exit $p.ExitCode
      } catch { exit 1223 } finally { if($sha){$sha.Dispose()}; if($handle){$handle.Dispose()} }`;
      const launcher = spawn(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
      session.launcher = launcher;
      launcher.once('error', () => { session.exited = true; });
      launcher.once('exit', () => {
        session.exited = true;
        void fs.unlink(path.join(session.directory, 'network.toml')).catch(() => {});
        if (current === session) void stop(session.lease);
      });
      let stable = '', since = 0;
      const deadline = Date.now() + 90000;
      while (!session.cancelled && Date.now() < deadline) {
        if (session.exited) throw new Error('校园互联未能启动；请允许 Windows 权限请求，或关闭校园互联后重试。');
        const failure = await fs.readFile(path.join(session.directory, 'failed'), 'utf8').catch(() => '');
        if (failure) throw new Error('校园互联初始化失败，请检查系统的网卡与防火墙权限。');
        const entries = os.networkInterfaces()[value.device] || [];
        const address = entries.find(item => item.family === 'IPv4' && item.address.startsWith(`${value.prefix}.`))?.address;
        const ready = await fs.access(path.join(session.directory, 'ready')).then(() => true, () => false);
        if (address && ready) {
          if (stable !== address) { stable = address; since = Date.now(); }
          if (Date.now() - since >= 2000) {
            session.adapter = createCampusAdapter(address, () => { if (current === session) void stop(session.lease); });
            const iceServer = await session.adapter.ready;
            if (session.cancelled || current !== session) { await session.adapter.stop(); throw new Error('EasyTier 已取消。'); }
            onActive({ lease: value.lease, address, ports: PORTS });
            let missingSince = 0;
            session.monitor = setInterval(() => {
              const present = (os.networkInterfaces()[value.device] || []).some(item => item.address === address);
              if (present) missingSince = 0;
              else if (!missingSince) missingSince = Date.now();
              else if (Date.now() - missingSince > 3000) void stop(session.lease);
            }, 500);
            session.monitor.unref();
            return { lease: value.lease, address, iceServer };
          }
        } else { stable = ''; since = 0; }
        await sleep(250);
      }
      throw new Error(session.cancelled ? '校园互联已取消。' : '校园互联启动超时，请重新加入房间。');
    } catch (error) {
      try { await stop(value.lease); }
      finally {
        // Cancellation can clear current while directory protection is awaited.
        // Always clean this request's late-written config, without touching a
        // newer lease; a running supervisor retains responsibility for its lock.
        if (session.directory && (!session.launcher || session.exited)) {
          await fs.unlink(path.join(session.directory, 'network.toml')).catch(() => {});
        }
      }
      throw error;
    }
  };
  return { start, stop: lease => { if (lease && !LEASE.test(lease)) throw new Error('校园互联会话无效。'); return stop(lease); } };
}

module.exports = { createCampusNetwork };
