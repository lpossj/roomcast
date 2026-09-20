const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const SCENE = 'Roomcast Fixed FPS';
const EMBEDDED_OBS_VERSION = '32.1.2';
const EMBEDDED_MARKERS = Object.freeze(['roomcast-embedded-obs.json', '.roomcast-embedded-obs.json']);
const EMBEDDED_MARKER = EMBEDDED_MARKERS[1];
const WORK_MARKER = '.roomcast-fixed-fps.json';
const CAPTURE_INPUT = 'Roomcast Capture';
const PROBE_PREFIX = 'Roomcast Probe ';
const VIDEO_PROBES = Object.freeze({
  monitors: { inputKind: 'monitor_capture', propertyName: 'monitor_id' },
  windows: { inputKind: 'window_capture', propertyName: 'window' },
});

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}


const REQUIRED_EMBEDDED_OBS_PATHS = Object.freeze([
  'bin/64bit/obs64.exe',
  'obs-plugins/64bit/obs-websocket.dll',
  'obs-plugins/64bit/win-dshow.dll',
  'data/obs-plugins/win-capture',
  'data/obs-plugins/win-dshow/obs-virtualcam-module64.dll',
]);

function uniqueResolvedPaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text) continue;
    const resolved = path.resolve(text);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function embeddedObsBundleCandidates({
  runtimeRoot = '',
  envBundle = process.env.ROOMCAST_OBS_BUNDLE,
  resourcesPath = process.resourcesPath,
  execPath = process.execPath,
} = {}) {
  const exeDir = execPath ? path.dirname(execPath) : '';
  return uniqueResolvedPaths([
    envBundle,
    runtimeRoot ? path.join(runtimeRoot, 'runtime', 'obs-bundle') : '',
    resourcesPath ? path.join(resourcesPath, 'runtime', 'obs-bundle') : '',
    exeDir ? path.join(exeDir, 'resources', 'runtime', 'obs-bundle') : '',
  ]);
}

async function inspectEmbeddedObsBundle(bundleDir) {
  const resolved = path.resolve(bundleDir);
  const missing = [];
  for (const relative of REQUIRED_EMBEDDED_OBS_PATHS) {
    if (!(await exists(path.join(resolved, ...relative.split('/'))))) missing.push(relative);
  }

  let markerPath = '';
  let marker = null;
  let markerError = '';
  for (const markerName of EMBEDDED_MARKERS) {
    const candidate = path.join(resolved, markerName);
    if (!(await exists(candidate))) continue;
    markerPath = candidate;
    try {
      marker = JSON.parse(await fs.readFile(candidate, 'utf8'));
      markerError = '';
      break;
    } catch (error) {
      markerError = `marker parse failed: ${error?.message || error}`;
    }
  }

  if (!markerPath) missing.push(`marker (${EMBEDDED_MARKERS.join(' or ')})`);
  else if (!marker) missing.push(markerError || 'marker is invalid');
  else if (marker.version !== EMBEDDED_OBS_VERSION) {
    missing.push(`marker version=${marker.version || 'unknown'} expected=${EMBEDDED_OBS_VERSION}`);
  }

  return {
    ok: missing.length === 0,
    bundleDir: resolved,
    markerPath,
    marker,
    missing,
  };
}

async function resolveEmbeddedObsBundle({ candidates = [] } = {}) {
  const diagnostics = [];
  for (const candidate of uniqueResolvedPaths(candidates)) {
    const inspected = await inspectEmbeddedObsBundle(candidate);
    if (inspected.ok) return { ...inspected, diagnostics };
    diagnostics.push({
      bundleDir: inspected.bundleDir,
      missing: inspected.missing,
    });
  }

  const details = diagnostics.length
    ? diagnostics.map(item => `  - ${item.bundleDir}: ${item.missing.join('; ')}`).join('\n')
    : '  - no candidate paths were available';

  const error = new Error(
    `Roomcast 内置 OBS Runtime 不可用。\n已检查：\n${details}\n`
    + '请重新安装或重新获取完整的 Roomcast 发布包；普通用户不需要运行 npm 命令。',
  );
  error.code = 'OBS_EMBEDDED_RUNTIME_MISSING';
  error.diagnostics = diagnostics;
  throw error;
}


async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function withDeadline(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitForObsVirtualCameraState(client, expectedActive, { timeoutMs = 6000, pollMs = 100, delayFn = delay } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      last = await client.request('GetVirtualCamStatus');
      lastError = null;
      if (Boolean(last.outputActive) === Boolean(expectedActive)) return last;
    } catch (error) {
      lastError = error;
    }
    await delayFn(pollMs);
  }
  const state = last ? `最后状态 outputActive=${Boolean(last.outputActive)}` : '没有取得有效状态';
  const cause = lastError ? `；最后错误：${lastError.message}` : '';
  throw new Error(`等待 OBS Virtual Camera ${expectedActive ? '启动' : '停止'}超时（${timeoutMs}ms，${state}${cause}）。`);
}


async function waitForObsVirtualCameraAvailable(engine, { timeoutMs = 12000, pollMs = 200, delayFn = delay } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError = null;
  let lastCapability = null;
  while (Date.now() <= deadline) {
    attempts += 1;
    try {
      lastCapability = await engine.virtualCameraCapability();
      lastError = null;
      if (lastCapability?.available) return { ...lastCapability, attempts };
    } catch (error) {
      lastError = error;
    }
    await delayFn(pollMs);
  }
  const reason = lastCapability?.reason ? `；最后状态：${lastCapability.reason}` : '';
  const cause = lastError ? `；最后错误：${lastError.message}` : '';
  const error = new Error(`等待 OBS Virtual Camera 初始化超时（${timeoutMs}ms，尝试 ${attempts} 次${reason}${cause}）。`);
  error.code = lastCapability?.reason === 'obs-output-unavailable'
    ? 'OBS_VIRTUALCAM_OUTPUT_UNAVAILABLE'
    : 'OBS_VIRTUALCAM_READY_TIMEOUT';
  throw error;
}

async function portOccupied(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = value => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

function childHasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMs = 8000) {
  if (childHasExited(child)) {
    return Promise.resolve({ exited: true, code: child?.exitCode ?? null, signal: child?.signalCode ?? null });
  }
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.('exit', onExit);
      resolve(result);
    };
    const onExit = (code, signal) => finish({ exited: true, code: Number.isInteger(code) ? code : null, signal: signal ? String(signal) : null });
    child.once('exit', onExit);
    if (childHasExited(child)) {
      finish({ exited: true, code: child.exitCode ?? null, signal: child.signalCode ?? null });
      return;
    }
    timer = setTimeout(() => finish({ exited: false, code: null, signal: null }), timeoutMs);
  });
}

function requestGracefulWindowsProcessClose(pid) {
  return new Promise(resolve => {
    if (process.platform !== 'win32' || !Number.isInteger(Number(pid)) || Number(pid) <= 0) {
      resolve({ requested: false, code: null, reason: 'unsupported' });
      return;
    }
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let taskkill;
    try {
      // Intentionally omit /F. For a local GUI process taskkill requests a
      // normal window close first, allowing OBS/Qt and capture threads to tear
      // down cleanly. Force termination is a last-resort fallback below.
      taskkill = spawn('taskkill.exe', ['/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (error) {
      finish({ requested: false, code: null, reason: error.message });
      return;
    }
    taskkill.once('error', error => finish({ requested: false, code: null, reason: error.message }));
    taskkill.once('exit', code => finish({ requested: code === 0, code: Number.isInteger(code) ? code : null, reason: code === 0 ? '' : `taskkill exit ${code}` }));
  });
}

async function gracefulTerminateObsProcess(child, {
  gracefulTimeoutMs = 8000,
  forceTimeoutMs = 3000,
  requestClose = requestGracefulWindowsProcessClose,
} = {}) {
  if (!child || childHasExited(child)) {
    return { exited: true, forced: false, gracefulRequested: false, code: child?.exitCode ?? null, signal: child?.signalCode ?? null };
  }

  const requestResult = await requestClose(child.pid).catch(error => ({ requested: false, code: null, reason: error.message }));
  const graceful = await waitForChildExit(child, gracefulTimeoutMs);
  if (graceful.exited) {
    return { ...graceful, forced: false, gracefulRequested: requestResult?.requested === true, requestResult };
  }

  let forceIssued = false;
  try { forceIssued = child.kill() !== false; } catch { }
  const forced = await waitForChildExit(child, forceTimeoutMs);
  if (!forced.exited) {
    throw new Error(`OBS 进程 ${child.pid || 'unknown'} 在正常退出和强制退出后仍未结束。`);
  }
  return { ...forced, forced: true, forceIssued, gracefulRequested: requestResult?.requested === true, requestResult };
}

function requestForceWindowsProcessTreeKill(pid) {
  return new Promise(resolve => {
    if (process.platform !== 'win32' || !Number.isInteger(Number(pid)) || Number(pid) <= 0) {
      resolve({ requested: false, code: null, reason: 'unsupported' });
      return;
    }
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let taskkill;
    try {
      // OBS is an isolated Roomcast-owned helper process. After outputs and
      // capture inputs have been stopped/removed through obs-websocket, do not
      // ask the full OBS/Qt frontend to tear itself down. OBS can crash while
      // freeing frontend/plugin context on exit; terminating the private process
      // tree avoids that teardown path and also prevents CEF/plugin children
      // from being orphaned.
      taskkill = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (error) {
      finish({ requested: false, code: null, reason: error.message });
      return;
    }
    taskkill.once('error', error => finish({ requested: false, code: null, reason: error.message }));
    taskkill.once('exit', code => finish({
      requested: code === 0,
      code: Number.isInteger(code) ? code : null,
      reason: code === 0 ? '' : `taskkill /T /F exit ${code}`,
    }));
  });
}

async function terminateManagedObsProcess(child, {
  timeoutMs = 5000,
  fallbackTimeoutMs = 1500,
  requestKill = requestForceWindowsProcessTreeKill,
} = {}) {
  if (!child || childHasExited(child)) {
    return {
      exited: true,
      forced: false,
      managed: true,
      processTreeRequested: false,
      code: child?.exitCode ?? null,
      signal: child?.signalCode ?? null,
    };
  }

  const requestResult = await requestKill(child.pid).catch(error => ({ requested: false, code: null, reason: error.message }));
  if (requestResult?.requested === true) {
    const treeExit = await waitForChildExit(child, timeoutMs);
    if (treeExit.exited) {
      return {
        ...treeExit,
        forced: true,
        managed: true,
        processTreeRequested: true,
        requestResult,
      };
    }
  }

  // Non-Windows tests and the rare taskkill failure use Node's TerminateProcess
  // path as a final fallback. This is still intentionally non-graceful: all OBS
  // outputs and inputs were already dismantled before reaching this function.
  let forceIssued = false;
  try { forceIssued = child.kill() !== false; } catch { }
  const fallbackExit = await waitForChildExit(child, fallbackTimeoutMs);
  if (!fallbackExit.exited) {
    throw new Error(`Roomcast 管理的 OBS 进程 ${child.pid || 'unknown'} 无法结束。`);
  }
  return {
    ...fallbackExit,
    forced: true,
    managed: true,
    processTreeRequested: requestResult?.requested === true,
    forceIssued,
    requestResult,
  };
}

function obsAuthentication(password, salt, challenge) {
  const secret = createHash('sha256')
    .update(`${password}${salt}`)
    .digest('base64');
  return createHash('sha256')
    .update(`${secret}${challenge}`)
    .digest('base64');
}

class ObsWebSocketClient {
  constructor({ WebSocketImpl } = {}) {
    this.WebSocketImpl = WebSocketImpl || globalThis.WebSocket;
    this.socket = null;
    this.pending = new Map();
    this.ready = false;
    this.sequence = 0;
    this.generation = 0;
  }

  #isCurrent(socket, generation) {
    return this.socket === socket && this.generation === generation;
  }

  async connect(url, password) {
    const WebSocketCtor = this.WebSocketImpl;
    if (typeof WebSocketCtor !== 'function') {
      throw new Error('当前 Node/Electron 运行时缺少 WebSocket 支持。');
    }
    await this.close();

    const generation = ++this.generation;
    const socket = new WebSocketCtor(url);
    this.socket = socket;
    this.ready = false;

    const identified = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const fail = event => settle(reject, new Error(event?.message || 'OBS WebSocket 连接失败。'));
      socket.addEventListener('error', fail, { once: true });
      socket.addEventListener('close', event => {
        // An OBS restart intentionally closes the previous websocket. Windows
        // can deliver that old close event after the new OBS websocket has
        // already connected. A stale socket must never mark the new connection
        // not-ready or reject requests that belong to the new connection.
        if (!this.#isCurrent(socket, generation)) {
          if (!settled) settle(reject, new Error(`旧 OBS WebSocket 已关闭（${event.code || 0}）。`));
          return;
        }
        if (!this.ready) settle(reject, new Error(`OBS WebSocket 已关闭（${event.code || 0}）。`));
        this.#rejectPending(new Error('OBS WebSocket 已断开。'));
        this.ready = false;
        this.socket = null;
      });
      socket.addEventListener('message', event => {
        if (!this.#isCurrent(socket, generation)) return;
        try {
          const packet = JSON.parse(String(event.data));
          if (packet.op === 0) {
            const auth = packet.d?.authentication;
            const identify = { rpcVersion: 1, eventSubscriptions: 0 };
            if (auth) {
              if (!password) throw new Error('OBS WebSocket 要求密码，但 Roomcast 没有控制密码。');
              identify.authentication = obsAuthentication(password, auth.salt, auth.challenge);
            }
            socket.send(JSON.stringify({ op: 1, d: identify }));
            return;
          }
          if (packet.op === 2) {
            this.ready = true;
            settle(resolve, packet.d || {});
            return;
          }
          if (packet.op === 7) {
            const requestId = packet.d?.requestId;
            const pending = this.pending.get(requestId);
            if (!pending) return;
            this.pending.delete(requestId);
            const status = packet.d?.requestStatus;
            if (!status?.result) {
              const error = new Error(`OBS 请求失败：${pending.type}（${status?.code ?? 'unknown'}）${status?.comment ? ` ${status.comment}` : ''}`);
              error.code = status?.code;
              pending.reject(error);
              return;
            }
            pending.resolve(packet.d?.responseData || {});
          }
        } catch (error) {
          if (!this.ready) settle(reject, error);
        }
      });
    });

    await withDeadline(identified, 2500, '等待 OBS WebSocket 握手超时。');
    return true;
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(type, data = {}, timeout = 8000) {
    const WebSocketCtor = this.WebSocketImpl;
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocketCtor.OPEN) {
      return Promise.reject(new Error('OBS WebSocket 尚未连接。'));
    }
    const socket = this.socket;
    const generation = this.generation;
    const requestId = `roomcast-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    const task = new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, type, generation });
      socket.send(JSON.stringify({
        op: 6,
        d: { requestType: type, requestId, requestData: data },
      }));
    });
    return withDeadline(task, timeout, `OBS 请求超时：${type}`).finally(() => {
      const pending = this.pending.get(requestId);
      if (pending?.generation === generation) this.pending.delete(requestId);
    });
  }

  async close() {
    const socket = this.socket;
    if (!socket) {
      this.ready = false;
      return;
    }
    // Detach the socket before asking the OS to close it. Its eventual close
    // event is now stale by definition and cannot mutate a later connection.
    this.socket = null;
    this.ready = false;
    this.#rejectPending(new Error('OBS WebSocket 已关闭。'));
    try {
      socket.close(1000, 'Roomcast closing');
    } catch { }
  }
}

function bindObsProcessLifecycle(engine, child) {
  child.once('exit', (code, signal) => {
    if (engine.process !== child) return;
    engine.process = null;
    engine.capture = null;
    void engine.client.close().catch(() => {});
    if (!engine.closing && engine.onUnexpectedExit) {
      try {
        engine.onUnexpectedExit({
          code: Number.isInteger(code) ? code : null,
          signal: signal ? String(signal) : '',
        });
      } catch { }
    }
  });
}

class ObsFixedFpsEngine {
  constructor({ rootDir, runtimeRoot, dataRoot, port = 4457, onUnexpectedExit, allowBundleOverride = true } = {}) {
    const fallbackRoot = rootDir || runtimeRoot || dataRoot;
    if (!fallbackRoot) throw new Error('OBS 固定帧率引擎需要运行时/数据根目录。');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('OBS 控制端口无效。');
    this.runtimeRoot = path.resolve(runtimeRoot || rootDir || fallbackRoot);
    this.dataRoot = path.resolve(dataRoot || rootDir || fallbackRoot);
    this.rootDir = this.dataRoot;
    this.port = port;
    this.bundleCandidates = embeddedObsBundleCandidates({
      runtimeRoot: this.runtimeRoot,
      envBundle: allowBundleOverride ? process.env.ROOMCAST_OBS_BUNDLE : '',
      resourcesPath: process.resourcesPath,
      execPath: process.execPath,
    });
    this.bundleDir = this.bundleCandidates[0] || path.join(this.runtimeRoot, 'runtime', 'obs-bundle');
    this.obsDir = path.resolve(process.env.ROOMCAST_OBS_RUNTIME || path.join(this.dataRoot, 'runtime', 'obs-fixed-fps'));
    this.exe = path.join(this.obsDir, 'bin', '64bit', 'obs64.exe');
    this.configDir = path.join(this.obsDir, 'config', 'obs-studio');
    this.embeddedVersion = '';
    this.process = null;
    this.client = new ObsWebSocketClient();
    this.password = '';
    this.version = '';
    this.probes = new Set();
    // Names OBS already accepted RemoveInput for. obs_source_remove() only
    // marks the source removed; the OBS object (and therefore GetInputList)
    // keeps reporting it until the destruction task thread actually frees it.
    // Those names must never be re-added as "still alive" probes, otherwise
    // cleanup can never confirm success and sources() fails intermittently.
    this.removedOwnedInputs = new Set();
    this.capture = null;
    this.closing = false;
    this.onUnexpectedExit = typeof onUnexpectedExit === 'function' ? onUnexpectedExit : null;
  }

  async prepare() {
    if (process.platform !== 'win32') throw new Error('OBS 固定帧率采集目前只支持 Windows。');

    const resolvedBundle = await resolveEmbeddedObsBundle({ candidates: this.bundleCandidates });
    this.bundleDir = resolvedBundle.bundleDir;
    const bundleMarker = resolvedBundle.marker;
    this.embeddedVersion = bundleMarker.version;

    const workMarkerPath = path.join(this.obsDir, WORK_MARKER);
    let workMarker;
    try { workMarker = JSON.parse(await fs.readFile(workMarkerPath, 'utf8')); } catch { }
    const ready = workMarker?.embeddedVersion === EMBEDDED_OBS_VERSION
      && (await Promise.all(REQUIRED_EMBEDDED_OBS_PATHS.map(relative => exists(path.join(this.obsDir, relative))))).every(Boolean);
    if (ready) {
      return {
        prepared: true,
        obsDir: this.obsDir,
        bundleDir: this.bundleDir,
        copied: false,
        source: 'embedded',
        version: EMBEDDED_OBS_VERSION,
      };
    }

    const workExists = await exists(this.obsDir);
    if (workExists && !(await exists(workMarkerPath))) {
      throw new Error(`拒绝覆盖未识别的 OBS 工作目录：${this.obsDir}`);
    }
    // Never publish an incomplete working copy. Interrupted staging directories
    // cannot poison the next attempt, and the prior managed copy stays intact
    // until all replacement files have been copied successfully.
    await fs.mkdir(path.dirname(this.obsDir), { recursive: true });
    const stagingDir = await fs.mkdtemp(`${this.obsDir}.prepare-`);
    try {
      for (const folder of ['bin', 'data', 'obs-plugins']) {
        const from = path.join(this.bundleDir, folder);
        if (!(await exists(from))) throw new Error(`Roomcast 内置 OBS 不完整：缺少 ${folder}。`);
        await fs.cp(from, path.join(stagingDir, folder), { recursive: true, force: true });
      }
      await fs.writeFile(path.join(stagingDir, 'portable_mode.txt'), '');
      await writeJson(path.join(stagingDir, WORK_MARKER), {
        schema: 2,
        embeddedVersion: EMBEDDED_OBS_VERSION,
        bundleBinarySha256: bundleMarker.binarySha256 || null,
        preparedAt: new Date().toISOString(),
        purpose: 'Roomcast isolated fixed-FPS capture backend',
      });
      if (workExists) await fs.rm(this.obsDir, { recursive: true, force: true });
      await fs.rename(stagingDir, this.obsDir);
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
    return {
      prepared: true,
      obsDir: this.obsDir,
      bundleDir: this.bundleDir,
      copied: true,
      source: 'embedded',
      version: EMBEDDED_OBS_VERSION,
    };
  }

  virtualCameraModules() {
    return {
      module32: path.join(this.obsDir, 'data', 'obs-plugins', 'win-dshow', 'obs-virtualcam-module32.dll'),
      module64: path.join(this.obsDir, 'data', 'obs-plugins', 'win-dshow', 'obs-virtualcam-module64.dll'),
    };
  }

  async virtualCameraCapability() {
    if (!this.client.ready) throw new Error('OBS 尚未连接。');
    try {
      const status = await this.client.request('GetVirtualCamStatus');
      return { available: true, active: Boolean(status.outputActive), reason: 'available' };
    } catch (error) {
      const message = String(error?.message || '');
      if (/VirtualCam is not available|GetVirtualCamStatus（?604|GetVirtualCamStatus.*604/i.test(message)) {
        return {
          available: false,
          active: false,
          reason: 'obs-output-unavailable',
          message,
        };
      }
      throw error;
    }
  }

  async #writeConfig({ width = 1920, height = 1080, fps = 60 } = {}) {
    const profileDir = path.join(this.configDir, 'basic', 'profiles', SCENE);
    await fs.mkdir(profileDir, { recursive: true });
    const common = [
      '[General]',
      'FirstRun=true',
      'LicenseAccepted=true',
      'EnableAutoUpdates=false',
      'ConfirmOnExit=false',
      '',
      '[Basic]',
      `Profile=${SCENE}`,
      `ProfileDir=${SCENE}`,
      `SceneCollection=${SCENE}`,
      `SceneCollectionFile=${SCENE}`,
      '',
      '[BasicWindow]',
      'PreviewEnabled=false',
      'PreviewProgramMode=false',
      'SysTrayEnabled=true',
      'SysTrayWhenStarted=true',
      'HideOBSWindowsFromCapture=true',
      '',
    ].join('\n');
    await fs.writeFile(path.join(this.configDir, 'global.ini'), `${common}[Video]\nRenderer=Direct3D 11\n`);
    await fs.writeFile(path.join(this.configDir, 'user.ini'), common);
    await fs.writeFile(path.join(profileDir, 'basic.ini'), [
      '[General]',
      `Name=${SCENE}`,
      '',
      '[Video]',
      `BaseCX=${width}`,
      `BaseCY=${height}`,
      `OutputCX=${width}`,
      `OutputCY=${height}`,
      'FPSType=0',
      `FPSCommon=${fps}`,
      'ScaleType=bicubic',
      'ColorFormat=NV12',
      'ColorSpace=709',
      'ColorRange=Partial',
      '',
      '[Audio]',
      'SampleRate=48000',
      'ChannelSetup=Stereo',
      '',
    ].join('\n'));

    const sceneId = randomUUID();
    await writeJson(path.join(this.configDir, 'basic', 'scenes', `${SCENE}.json`), {
      name: SCENE,
      current_scene: SCENE,
      current_program_scene: SCENE,
      scene_order: [{ name: SCENE }],
      sources: [{
        name: SCENE,
        uuid: sceneId,
        id: 'scene',
        versioned_id: 'scene',
        settings: { items: [] },
        mixers: 0,
      }],
      groups: [],
      transitions: [],
      quick_transitions: [],
      saved_projectors: [],
      current_transition: 'Fade',
      transition_duration: 0,
    });

    this.password = randomBytes(36).toString('base64url');
    await writeJson(path.join(this.configDir, 'plugin_config', 'obs-websocket', 'config.json'), {
      first_load: false,
      server_enabled: true,
      server_port: this.port,
      alerts_enabled: false,
      auth_required: true,
      server_password: this.password,
    });

    const sentinelDir = path.join(this.configDir, '.sentinel');
    for (const entry of await fs.readdir(sentinelDir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && entry.name.startsWith('run_')) {
        await fs.unlink(path.join(sentinelDir, entry.name)).catch(() => {});
      }
    }
  }

  async launch({ width = 1920, height = 1080, fps = 60 } = {}) {
    if (this.process && this.client.ready) return this.status();
    await this.prepare();
    if (await portOccupied(this.port)) {
      throw new Error(`OBS 本地控制端口 ${this.port} 已被占用。请先关闭旧的 Roomcast OBS 测试实例。`);
    }
    const settings = validateVideoSettings({ width, height, fps });
    await this.#writeConfig(settings);

    const args = [
      '--portable', '--multi', '--profile', SCENE, '--collection', SCENE,
      '--scene', SCENE, '--minimize-to-tray', '--disable-updater',
      '--only-bundled-plugins', '--disable-missing-files-check', '--websocket_ipv4_only',
    ];
    const child = spawn(this.exe, args, {
      cwd: path.dirname(this.exe),
      windowsHide: true,
      stdio: 'ignore',
    });
    this.process = child;
    this.closing = false;
    bindObsProcessLifecycle(this, child);

    let lastError;
    for (let attempt = 0; attempt < 50 && this.process; attempt++) {
      try {
        await this.client.connect(`ws://127.0.0.1:${this.port}`, this.password);
        const version = await this.client.request('GetVersion');
        const required = [
          'SetVideoSettings',
          'GetVideoSettings',
          'CreateInput',
          'RemoveInput',
          'GetInputPropertiesListPropertyItems',
          'GetVirtualCamStatus',
          'StartVirtualCam',
          'StopVirtualCam',
          'GetSceneItemId',
          'RemoveSceneItem',
          'SetSceneItemTransform',
          'GetInputSettings',
          'GetInputList',
          'GetStats',
        ];
        if (!required.every(name => version.availableRequests?.includes(name))) {
          throw new Error('Roomcast 内置 OBS/obs-websocket 缺少固定帧率采集所需接口，请重新准备官方内置组件。');
        }
        this.version = version.obsVersion || '';
        if (this.version !== EMBEDDED_OBS_VERSION) {
          throw new Error(`Roomcast OBS Runtime 版本不一致：期望 ${EMBEDDED_OBS_VERSION}，实际 ${this.version || 'unknown'}。`);
        }
        await this.configureVideo(settings);
        return this.status();
      } catch (error) {
        lastError = error;
        await this.client.close().catch(() => {});
        await delay(300);
      }
    }

    await this.close().catch(() => {});
    throw new Error(`OBS 固定帧率引擎启动失败：${lastError?.message || 'OBS 进程提前退出'}`);
  }

  async configureVideo(options = {}) {
    const settings = validateVideoSettings(options);
    if (!this.client.ready) throw new Error('OBS 尚未连接。');
    const virtualCam = await this.client.request('GetVirtualCamStatus').catch(() => ({ outputActive: false }));
    if (virtualCam.outputActive) throw new Error('OBS 虚拟摄像头正在输出，必须先停止输出才能修改帧率。');
    const stream = await this.client.request('GetStreamStatus').catch(() => ({ outputActive: false }));
    if (stream.outputActive) throw new Error('OBS 正在推流，必须先停止输出才能修改帧率。');

    await this.client.request('SetVideoSettings', {
      baseWidth: settings.width,
      baseHeight: settings.height,
      outputWidth: settings.width,
      outputHeight: settings.height,
      fpsNumerator: settings.fps,
      fpsDenominator: 1,
    });
    const actual = await this.client.request('GetVideoSettings');
    if (
      actual.baseWidth !== settings.width
      || actual.baseHeight !== settings.height
      || actual.outputWidth !== settings.width
      || actual.outputHeight !== settings.height
      || actual.fpsNumerator !== settings.fps
      || actual.fpsDenominator !== 1
    ) {
      throw new Error(`OBS 没有接受固定帧率设置：期望 ${settings.width}x${settings.height}@${settings.fps}，实际 ${actual.outputWidth}x${actual.outputHeight}@${actual.fpsNumerator}/${actual.fpsDenominator}。`);
    }
    return { ...settings, actual };
  }

  async #listProbeInputs() {
    if (!this.client.ready) return [...this.probes];
    const response = await this.client.request('GetInputList');
    return (response.inputs || [])
      .map(item => String(item?.inputName || ''))
      .filter(name => name.startsWith(PROBE_PREFIX) && !this.removedOwnedInputs.has(name));
  }

  async removeOwnedInput(inputName) {
    // RemoveInput marks the source removed, but scene references can survive
    // until a render tick. A minimized idle OBS may not render that scene.
    // Detach our scene item explicitly before removing/reusing the input.
    const item = await this.client.request('GetSceneItemId', {
      sceneName: SCENE, sourceName: inputName,
    }).catch(() => null);
    if (Number.isInteger(item?.sceneItemId)) {
      await this.client.request('RemoveSceneItem', { sceneName: SCENE, sceneItemId: item.sceneItemId });
    }
    await this.client.request('RemoveInput', { inputName }).catch(error => {
      // Detaching the last scene reference may already destroy the input.
      if (error.code !== 600) throw error;
    });
    // Only reachable when RemoveInput succeeded (or reported 600 = already
    // gone). Record it so late enumeration cannot resurrect it as a failure.
    this.removedOwnedInputs.add(inputName);
  }

  async cleanupProbeInputs({ timeoutMs = 2500, pollMs = 100, settleMs = 250, delayFn = delay } = {}) {
    if (!this.client.ready) {
      this.probes.clear();
      return { removed: [], remaining: [] };
    }

    const removed = new Set();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      let discovered = [];
      try { discovered = await this.#listProbeInputs(); } catch { discovered = [...this.probes]; }
      const candidates = [...new Set([...this.probes, ...discovered])];
      if (!candidates.length) {
        this.probes.clear();
        if (settleMs > 0) await delayFn(settleMs);
        return { removed: [...removed], remaining: [] };
      }

      for (const inputName of candidates) {
        try {
          await this.removeOwnedInput(inputName);
          removed.add(inputName);
          this.probes.delete(inputName);
        } catch {
          // Keep the name tracked. A later pass or close() must retry instead
          // of forgetting a probe whose WGC thread may still be alive.
          this.probes.add(inputName);
        }
      }

      let remaining = [];
      try { remaining = await this.#listProbeInputs(); } catch { remaining = [...this.probes]; }
      if (!remaining.length) {
        this.probes.clear();
        if (settleMs > 0) await delayFn(settleMs);
        return { removed: [...removed], remaining: [] };
      }
      await delayFn(pollMs);
    }

    let remaining = [];
    try { remaining = await this.#listProbeInputs(); } catch { remaining = [...this.probes]; }
    return { removed: [...removed], remaining };
  }

  async sources() {
    if (!this.client.ready) throw new Error('OBS 尚未连接。');

    // A previous interrupted enumeration must never leak a monitor/window
    // capture source into the next cycle. Those sources can own WGC threads.
    // Retry longer here because a prior probe must be gone before another
    // enumeration or a real capture is allowed to proceed.
    const stale = await this.cleanupProbeInputs({ timeoutMs: 5000, settleMs: 0 });
    if (stale.remaining.length) {
      throw new Error(`OBS 临时枚举源无法清理：${stale.remaining.join(', ')}`);
    }

    const result = { monitors: [], windows: [] };
    try {
      for (const [category, descriptor] of Object.entries(VIDEO_PROBES)) {
        const inputName = `${PROBE_PREFIX}${category} ${randomUUID()}`;
        this.probes.add(inputName);
        try {
          await this.client.request('CreateInput', {
            sceneName: SCENE,
            inputName,
            inputKind: descriptor.inputKind,
            inputSettings: category === 'monitors'
              ? { monitor_id: 'invalid', capture_cursor: true }
              : { window: '', cursor: true, client_area: true },
            sceneItemEnabled: false,
          });
          const response = await this.client.request('GetInputPropertiesListPropertyItems', {
            inputName,
            propertyName: descriptor.propertyName,
          });
          result[category] = (response.propertyItems || [])
            .filter(item => item?.itemEnabled !== false && item?.itemValue !== '' && item?.itemValue != null)
            .map(item => ({ id: String(item.itemValue), name: String(item.itemName || item.itemValue) }));
        } finally {
          try {
            await this.removeOwnedInput(inputName);
            this.probes.delete(inputName);
          } catch {
            // Do not drop tracking on failure. cleanupProbeInputs()/close()
            // will retry until OBS confirms the temporary input is gone.
            this.probes.add(inputName);
          }
        }
      }
    } finally {
      // Enumeration data is already valid at this point. OBS/WGC can
      // occasionally acknowledge RemoveInput late during the first source scan,
      // so do not discard a valid source list for a short foreground cleanup.
      // cleanupProbeInputs() keeps anything it could not remove tracked, and
      // the next sources()/selectSource() call performs a strict pre-clean.
      await this.cleanupProbeInputs({ timeoutMs: 1200, settleMs: 150 });
    }
    return result;
  }

  async selectSource({ type, id, cursor = true, clientArea = true } = {}) {
    if (!this.client.ready) throw new Error('OBS 尚未连接。');
    const normalizedType = type === 'monitor' ? 'monitor' : type === 'window' ? 'window' : '';
    if (!normalizedType) throw new Error('OBS 采集类型必须是 monitor 或 window。');
    const sourceId = String(id || '');
    if (!sourceId) throw new Error('OBS 采集源不能为空。');

    const available = await this.sources();
    const list = normalizedType === 'monitor' ? available.monitors : available.windows;
    const chosen = list.find(item => item.id === sourceId);
    if (!chosen) throw new Error('所选 OBS 屏幕或窗口已经不可用，请刷新后重试。');

    const virtualCam = await this.client.request('GetVirtualCamStatus').catch(() => ({ outputActive: false }));
    if (virtualCam.outputActive) await this.client.request('StopVirtualCam');

    await this.removeOwnedInput(CAPTURE_INPUT).catch(() => {});
    const descriptor = normalizedType === 'monitor' ? VIDEO_PROBES.monitors : VIDEO_PROBES.windows;
    const inputSettings = normalizedType === 'monitor'
      ? { monitor_id: sourceId, capture_cursor: cursor === true }
      : { window: sourceId, cursor: cursor === true, client_area: clientArea !== false };

    await this.client.request('CreateInput', {
      sceneName: SCENE,
      inputName: CAPTURE_INPUT,
      inputKind: descriptor.inputKind,
      inputSettings,
      sceneItemEnabled: true,
    });

    const item = await this.client.request('GetSceneItemId', {
      sceneName: SCENE,
      sourceName: CAPTURE_INPUT,
    });
    const video = await this.client.request('GetVideoSettings');
    await this.client.request('SetSceneItemTransform', {
      sceneName: SCENE,
      sceneItemId: item.sceneItemId,
      sceneItemTransform: {
        positionX: 0,
        positionY: 0,
        rotation: 0,
        boundsType: 'OBS_BOUNDS_STRETCH',
        boundsAlignment: 0,
        boundsWidth: video.baseWidth,
        boundsHeight: video.baseHeight,
      },
    });

    const actual = await this.client.request('GetInputSettings', { inputName: CAPTURE_INPUT });
    const actualId = String(actual.inputSettings?.[descriptor.propertyName] || '');
    if (actualId !== sourceId) {
      await this.removeOwnedInput(CAPTURE_INPUT).catch(() => {});
      throw new Error('OBS 没有接受所选采集源。');
    }

    this.capture = {
      type: normalizedType,
      id: sourceId,
      name: chosen.name,
      cursor: cursor === true,
      clientArea: normalizedType === 'window' ? clientArea !== false : undefined,
    };
    return { ...this.capture };
  }

  async startVirtualCamera() {
    if (!this.client.ready) throw new Error('OBS 尚未连接。');
    if (!this.capture) throw new Error('请先选择 OBS 屏幕或窗口。');
    const current = await this.client.request('GetVirtualCamStatus');
    if (!current.outputActive) await this.client.request('StartVirtualCam');
    // obs-websocket StartVirtualCam queues the start on OBS's UI thread and can
    // return before obs_frontend_virtualcam_active() flips to true. Poll the
    // real status instead of treating the first immediate read as definitive.
    try {
      await waitForObsVirtualCameraState(this.client, true, { timeoutMs: 6000, pollMs: 100 });
    } catch (error) {
      const diagnostics = await this.virtualCameraDiagnostics().catch(() => '');
      throw new Error(`${error.message}${diagnostics ? `\nOBS Virtual Camera 日志：\n${diagnostics}` : ''}`);
    }
    return { active: true, capture: { ...this.capture } };
  }

  async virtualCameraDiagnostics() {
    const logsDir = path.join(this.configDir, 'logs');
    const entries = await fs.readdir(logsDir, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.txt')) continue;
      const file = path.join(logsDir, entry.name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat) files.push({ file, mtimeMs: stat.mtimeMs });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (!files.length) return '';
    const text = await fs.readFile(files[0].file, 'utf8').catch(() => '');
    const relevant = text.split(/\r?\n/).filter(line => /virtual(?:cam| camera)|virtual output|win-dshow|obs-websocket.*(?:virtual|camera)/i.test(line));
    return relevant.slice(-16).join('\n');
  }

  async stopVirtualCamera() {
    if (!this.client.ready) return { active: false };
    const current = await this.client.request('GetVirtualCamStatus').catch(() => ({ outputActive: false }));
    if (current.outputActive) {
      await this.client.request('StopVirtualCam').catch(() => {});
      await waitForObsVirtualCameraState(this.client, false, { timeoutMs: 4000, pollMs: 100 }).catch(() => {});
    }
    return { active: false };
  }

  async captureScreenshot({ width, height, format = 'png', quality = -1 } = {}) {
    if (!this.client.ready) throw new Error('OBS 尚未连接。');
    if (!this.capture) throw new Error('请先选择 OBS 屏幕或窗口。');
    const request = {
      sourceName: CAPTURE_INPUT,
      imageFormat: String(format || 'png').toLowerCase(),
      imageCompressionQuality: Number.isFinite(Number(quality)) ? Number(quality) : -1,
    };
    if (Number.isFinite(Number(width)) && Number(width) > 0) request.imageWidth = Math.round(Number(width));
    if (Number.isFinite(Number(height)) && Number(height) > 0) request.imageHeight = Math.round(Number(height));

    const result = await this.client.request('GetSourceScreenshot', request, 12000);
    const imageData = String(result.imageData || '');
    const match = imageData.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/s);
    if (!match) throw new Error('OBS 没有返回有效的采集截图。');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length < 1024) throw new Error(`OBS 采集截图异常过小：${bytes.length} bytes。`);
    return {
      format: match[1].toLowerCase(),
      bytes,
      byteLength: bytes.length,
    };
  }

  async stats() {
    if (!this.client.ready) throw new Error('OBS 尚未连接。');
    const value = await this.client.request('GetStats');
    return {
      cpuUsage: Number(value.cpuUsage || 0),
      memoryUsage: Number(value.memoryUsage || 0),
      availableDiskSpace: Number(value.availableDiskSpace || 0),
      activeFps: Number(value.activeFps || 0),
      averageFrameRenderTime: Number(value.averageFrameRenderTime || 0),
      renderSkippedFrames: Number(value.renderSkippedFrames || 0),
      renderTotalFrames: Number(value.renderTotalFrames || 0),
      outputSkippedFrames: Number(value.outputSkippedFrames || 0),
      outputTotalFrames: Number(value.outputTotalFrames || 0),
      webSocketSessionIncomingMessages: Number(value.webSocketSessionIncomingMessages || 0),
      webSocketSessionOutgoingMessages: Number(value.webSocketSessionOutgoingMessages || 0),
    };
  }

  async clearSource() {
    if (!this.client.ready) {
      this.capture = null;
      return { ok: true };
    }
    await this.stopVirtualCamera().catch(() => {});
    await this.removeOwnedInput(CAPTURE_INPUT).catch(() => {});
    this.capture = null;
    return { ok: true };
  }

  async status() {
    if (!this.client.ready) {
      return {
        prepared: await exists(this.exe),
        running: Boolean(this.process),
        connected: false,
        version: this.version || null,
        embeddedVersion: this.embeddedVersion || EMBEDDED_OBS_VERSION,
        source: 'embedded',
      };
    }
    const video = await this.client.request('GetVideoSettings');
    const virtualCam = await this.client.request('GetVirtualCamStatus').catch(() => ({ outputActive: false }));
    return {
      prepared: true,
      running: Boolean(this.process),
      connected: true,
      version: this.version || null,
      embeddedVersion: this.embeddedVersion || EMBEDDED_OBS_VERSION,
      source: 'embedded',
      virtualCamActive: Boolean(virtualCam.outputActive),
      capture: this.capture ? { ...this.capture } : null,
      video: {
        width: video.outputWidth,
        height: video.outputHeight,
        fpsNumerator: video.fpsNumerator,
        fpsDenominator: video.fpsDenominator,
      },
    };
  }

  async close({ terminateTimeoutMs = 5000, fallbackTimeoutMs = 1500, terminateProcess = terminateManagedObsProcess, delayFn = delay } = {}) {
    this.closing = true;
    let probeCleanup = { removed: [], remaining: [] };
    let processResult = { exited: true, forced: false, managed: true, processTreeRequested: false };
    const child = this.process;
    try {
      if (this.client.ready) {
        // OBS is an internal capture worker, not a user-facing OBS session.
        // First stop the virtual camera and release every Roomcast-owned WGC
        // source through the supported websocket API. This gives capture worker
        // threads time to unwind before the process is terminated.
        await this.stopVirtualCamera().catch(() => {});
        await this.removeOwnedInput(CAPTURE_INPUT).catch(() => {});
        this.capture = null;
        probeCleanup = await this.cleanupProbeInputs({ timeoutMs: 3000, pollMs: 100, settleMs: 500, delayFn });

        // Ensure the OBS main thread has processed the removals before severing
        // control. We intentionally do NOT request a normal OBS frontend exit
        // afterwards: the clean-machine log showed a crash-on-exit at
        // `Freeing OBS context data`, after all normal shutdown stages began.
        await this.client.request('GetStats').catch(() => {});
        await delayFn(250);
      } else {
        this.probes.clear();
        this.capture = null;
      }

      await this.client.close().catch(() => {});
      await delayFn(100);

      if (child && !childHasExited(child)) {
        processResult = await terminateProcess(child, {
          timeoutMs: terminateTimeoutMs,
          fallbackTimeoutMs,
        });
      }
      if (this.process === child && childHasExited(child)) this.process = null;
      return {
        ok: true,
        probeCleanup,
        process: processResult,
      };
    } finally {
      if (this.process === child && childHasExited(child)) this.process = null;
      this.capture = null;
      this.closing = false;
    }
  }

}

function validateVideoSettings({ width = 1920, height = 1080, fps = 60 } = {}) {
  const normalized = {
    width: Math.round(Number(width)),
    height: Math.round(Number(height)),
    fps: Math.round(Number(fps)),
  };
  if (!Number.isInteger(normalized.width) || normalized.width < 320 || normalized.width > 4096) throw new Error('OBS 宽度必须在 320~4096。');
  if (!Number.isInteger(normalized.height) || normalized.height < 240 || normalized.height > 4096) throw new Error('OBS 高度必须在 240~4096。');
  if (normalized.width % 2 || normalized.height % 2) throw new Error('OBS 宽高必须为偶数。');
  if (!Number.isInteger(normalized.fps) || normalized.fps < 1 || normalized.fps > 120) throw new Error('OBS 帧率必须在 1~120 FPS。');
  return normalized;
}

module.exports = {
  ObsFixedFpsEngine,
  EMBEDDED_OBS_VERSION,
  EMBEDDED_MARKERS,
  REQUIRED_EMBEDDED_OBS_PATHS,
  embeddedObsBundleCandidates,
  inspectEmbeddedObsBundle,
  resolveEmbeddedObsBundle,
  validateVideoSettings,
  obsAuthentication,
  waitForObsVirtualCameraState,
  waitForObsVirtualCameraAvailable,
  ObsWebSocketClient,
  bindObsProcessLifecycle,
  childHasExited,
  waitForChildExit,
  requestGracefulWindowsProcessClose,
  gracefulTerminateObsProcess,
  requestForceWindowsProcessTreeKill,
  terminateManagedObsProcess,
};
