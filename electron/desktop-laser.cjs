const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const TRAIL_IDLE_MS = 1300;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
function sanitize(payload) {
  const packet = payload?.packet;
  if (!packet || !validId(packet.ownerId) || !validId(packet.from) || !validId(packet.strokeId)
    || !Number.isSafeInteger(packet.startedAt) || packet.startedAt < 0
    || !Number.isSafeInteger(packet.seq) || packet.seq < 0 || packet.seq > 0x7fffffff
    || !Array.isArray(packet.points) || packet.points.length > 8
    || !packet.points.every(point => Array.isArray(point) && point.length === 2
      && point.every(value => Number.isInteger(value) && value >= 0 && value <= 10000))
    || !Array.isArray(payload.members) || payload.members.length > 64) return null;
  const members = payload.members.filter(member => validId(member?.id) && typeof member.name === 'string'
    && member.name.length <= 96 && /^#[0-9a-f]{6}$/i.test(member.color || ''))
    .map(({ id, name, color }) => ({ id, name: name.replace(/[\u0000-\u001f]/g, ''), color }));
  if (!members.some(member => member.id === packet.from)) return null;
  return { packet: { ownerId: packet.ownerId, startedAt: packet.startedAt, from: packet.from,
    strokeId: packet.strokeId, seq: packet.seq, points: packet.points, done: packet.done === true }, members };
}

function createDesktopLaser({ app, BrowserWindow, ipcMain, screen, isOwner }) {
  let target = null, active = false, overlay = null, ready = false, bounds = null;
  let idleTimer = null, helper = null, generation = 0, helperGeneration = 0, queue = [], lastPacketAt = 0;
  let helperBuild = null, helperFailed = false;
  const rates = new Map();
  const displayEvents = ['display-added', 'display-removed', 'display-metrics-changed'];
  const destroySurface = () => {
    generation += 1;
    helperGeneration += 1;
    clearTimeout(idleTimer); idleTimer = null;
    if (helper) { const child = helper; helper = null; child.kill(); }
    for (const event of displayEvents) screen.removeListener(event, refreshDisplay);
    const previous = overlay; overlay = null; ready = false; bounds = null; queue = [];
    if (previous && !previous.isDestroyed()) previous.destroy();
  };
  const stop = () => { destroySurface(); target = null; active = false; rates.clear(); };
  const prepareHelper = () => {
    if (process.platform !== 'win32') return Promise.resolve(null);
    if (helperBuild) return helperBuild;
    helperBuild = (async () => {
      const source = await fs.promises.readFile(path.join(__dirname, 'desktop-laser-geometry.cs'));
      const hash = createHash('sha256').update(source).digest('hex').slice(0, 20);
      const directory = path.join(app.getPath('userData'), 'desktop-laser', hash);
      const executable = path.join(directory, 'RoomcastLaserGeometry.exe');
      if (fs.existsSync(executable)) return executable;
      const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
      const compiler = ['Framework64', 'Framework'].map(variant => path.join(windowsRoot, 'Microsoft.NET', variant, 'v4.0.30319', 'csc.exe')).find(candidate => fs.existsSync(candidate));
      if (!compiler) return null;
      await fs.promises.mkdir(directory, { recursive: true });
      const sourceFile = path.join(directory, 'desktop-laser-geometry.cs');
      await fs.promises.writeFile(sourceFile, source);
      // Source may live inside app.asar. Only this small source is copied out;
      // compilation is a local cache preparation step, never a runtime test.
      await new Promise((resolve, reject) => {
        const child = spawn(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${executable}`, sourceFile], { windowsHide: true, stdio: 'ignore' });
        const timeout = setTimeout(() => { child.kill(); reject(new Error('Geometry compiler timed out')); }, 15000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Geometry compilation unavailable')); });
      });
      return executable;
    })().catch(() => null);
    return helperBuild;
  };
  function applyBounds(value) {
    if (!overlay || overlay.isDestroyed()) return;
    if (!value?.visible) { bounds = null; overlay.hide(); return; }
    const rect = { x: value.x, y: value.y, width: value.width, height: value.height };
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0
      || rect.width > 32000 || rect.height > 32000 || Math.abs(rect.x) > 100000 || Math.abs(rect.y) > 100000) return;
    const dip = value.dip ? rect : screen.screenToDipRect(null, rect);
    const next = { x: Math.round(dip.x), y: Math.round(dip.y), width: Math.max(1, Math.round(dip.width)), height: Math.max(1, Math.round(dip.height)) };
    if (!bounds || Object.keys(next).some(key => next[key] !== bounds[key])) overlay.setBounds(next, false);
    bounds = next;
    if (ready && Date.now() - lastPacketAt < TRAIL_IDLE_MS && !overlay.isVisible()) overlay.showInactive();
  }
  async function startHelper() {
    if (!target || !overlay || helperFailed) return;
    const launch = ++helperGeneration;
    if (helper) { const previous = helper; helper = null; previous.kill(); }
    const currentGeneration = generation, currentTarget = target;
    const executable = await prepareHelper();
    if (generation !== currentGeneration || launch !== helperGeneration || target !== currentTarget || !overlay) return;
    if (!executable) { helperFailed = true; applyBounds(null); return; }
    let type = target.type, id = target.id;
    const args = [];
    if (target.hwnd) { type = 'hwnd'; id = target.hwnd; }
    args.push(type, Buffer.from(id, 'utf8').toString('base64'), target.clientArea ? 'client' : 'frame');
    args.push(target.pid ? String(target.pid) : '0', String(process.pid));
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    helper = child;
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (helper !== child || generation !== currentGeneration || launch !== helperGeneration) return;
      pending += chunk;
      if (pending.length > 8192) { helperFailed = true; child.kill(); applyBounds(null); return; }
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.visible && /^\d+$/.test(value.hwnd || '') && Number.isInteger(value.pid) && value.pid > 0 && target.type !== 'monitor') {
            target.hwnd = value.hwnd; target.pid = value.pid;
          }
          applyBounds(value);
        } catch { applyBounds(null); }
      }
    });
    child.once('error', () => { if (helper === child) { helper = null; helperFailed = true; applyBounds(null); } });
    child.once('exit', code => {
      if (helper !== child) return;
      helper = null;
      // Monitor geometry is a one-shot read refreshed by Electron display events.
      if (target?.type !== 'monitor' || code !== 0) { helperFailed = true; applyBounds(null); }
    });
  }
  function refreshDisplay() {
    if (!target || !overlay) return;
    if (target.type === 'screen') {
      const display = screen.getAllDisplays().find(item => String(item.id) === target.id);
      applyBounds(display ? { ...display.bounds, visible: true, dip: true } : null);
    } else if (target.type === 'monitor') { applyBounds(null); void startHelper(); }
    // A removed monitor may move a captured window. Its WinEvent hook follows it.
  }
  function ensureSurface() {
    if (overlay || process.platform !== 'win32' || !target || !active) return;
    const current = new BrowserWindow({ width: 1, height: 1, show: false, frame: false,
      transparent: true, backgroundColor: '#00000000', hasShadow: false, focusable: false,
      skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, enableLargerThanScreen: true, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'desktop-laser-preload.cjs'),
        nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
        partition: 'roomcast-desktop-laser' } });
    overlay = current;
    current.setIgnoreMouseEvents(true, { forward: false });
    current.setFocusable(false);
    current.setAlwaysOnTop(true, 'screen-saver');
    // Windows WDA_EXCLUDEFROMCAPTURE prevents a second copy of the trails in OBS
    // or native display capture. Apply before this window can become visible.
    current.setContentProtection(true);
    current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    current.webContents.on('will-navigate', event => event.preventDefault());
    current.webContents.once('did-finish-load', () => {
      if (overlay !== current || current.isDestroyed()) return;
      ready = true;
      for (const entry of queue) if (Date.now() - entry.at < 300) current.webContents.send('roomcast:desktop-laser-data', entry.value);
      queue = [];
      if (bounds && Date.now() - lastPacketAt < TRAIL_IDLE_MS) current.showInactive();
    });
    current.webContents.once('render-process-gone', () => { if (overlay === current) destroySurface(); });
    current.loadFile(path.join(__dirname, 'desktop-laser.html')).catch(() => { if (overlay === current) destroySurface(); });
    for (const event of displayEvents) screen.on(event, refreshDisplay);
    if (target.type === 'screen') refreshDisplay(); else void startHelper();
  }
  ipcMain.on('roomcast:desktop-laser', (event, payload) => {
    if (!isOwner(event) || process.platform !== 'win32' || !payload || typeof payload !== 'object') return;
    if (payload.captureStopped === true) { stop(); return; }
    if (payload.clear === true) { destroySurface(); rates.clear(); return; }
    if (payload.captureStarted === true) { active = Boolean(target); return; }
    if (!active || !target || helperFailed) return;
    const value = sanitize(payload);
    if (!value || !value.packet.points.length) return;
    const now = Date.now(), rate = rates.get(value.packet.from);
    if (rate && now - rate.at < 1000 && rate.count >= 40) return;
    if (!rate || now - rate.at >= 1000) {
      if (!rate && rates.size >= 64) rates.delete(rates.keys().next().value);
      rates.set(value.packet.from, { at: now, count: 1 });
    } else rate.count += 1;
    lastPacketAt = now;
    try { ensureSurface(); } catch { destroySurface(); helperFailed = true; return; }
    clearTimeout(idleTimer); idleTimer = setTimeout(destroySurface, TRAIL_IDLE_MS);
    if (ready && overlay && !overlay.isDestroyed()) overlay.webContents.send('roomcast:desktop-laser-data', value);
    else { queue.push({ value, at: now }); queue = queue.slice(-64); }
  });
  ipcMain.on('roomcast:desktop-laser-idle', event => {
    // The canvas can report idle after a later packet is already in IPC transit;
    // keep the main-process 1300 ms deadline authoritative.
    if (event.sender === overlay?.webContents && Date.now() - lastPacketAt >= TRAIL_IDLE_MS) destroySurface();
  });
  return {
    selectNative(source) {
      stop(); helperFailed = false;
      if (process.platform !== 'win32' || !source) return;
      if (source.id?.startsWith('screen:') && source.display_id) target = { type: 'screen', id: String(source.display_id), backend: 'native' };
      else { const match = /^window:(\d+):\d+$/.exec(source.id || ''); if (match) target = { type: 'hwnd', id: match[1], backend: 'native' }; }
      if (target && target.type !== 'screen') void prepareHelper();
    },
    selectObs(capture) {
      stop(); helperFailed = false;
      if (process.platform !== 'win32' || !capture?.id) return;
      target = { type: capture.type === 'monitor' ? 'monitor' : 'obs-window', id: capture.id,
        clientArea: capture.clientArea !== false, backend: 'obs' };
      void prepareHelper();
    },
    stop,
    stopObs() { if (target?.backend === 'obs') stop(); },
  };
}

module.exports = { createDesktopLaser };
