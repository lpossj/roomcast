const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');

// A single unprivileged helper per trusted renderer. The executable path and
// launch arguments are never supplied by the renderer or by signaling peers.
function installNativeIce({ ipcMain, owns, window, runtimeRoot }) {
  const sessions = new Set();
  let child;
  const executable = path.join(runtimeRoot, 'runtime/native-ice/RoomcastNativeIce.exe');
  const emit = message => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('roomcast:native-ice-event', message);
  };
  function stop() {
    const old = child;
    child = null;
    sessions.clear();
    old?.kill();
  }
  function start() {
    if (child) return child;
    const proc = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child = proc;
    const lost = () => {
      if (proc !== child) return;
      const ids = [...sessions];
      stop();
      for (const id of ids) emit({ id, event: 'error', reason: 'engine-exited' });
    };
    proc.once('exit', lost);
    proc.once('error', lost);
    proc.stdin.on('error', lost);
    const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (proc !== child) return;
      let message;
      try { message = JSON.parse(line); } catch { lost(); return; }
      if (sessions.has(message.id)) emit(message);
    });
    return proc;
  }
  ipcMain.handle('roomcast:native-ice', (event, message) => {
    if (!owns(event, window) || process.platform !== 'win32' || process.arch !== 'x64') throw new Error('原生连接不可用。');
    const { id, cmd } = message || {};
    if (!/^[a-f0-9-]{36}$/.test(id) || !['prepare','create','answer','candidate','local-candidate','send','stats','close'].includes(cmd)) throw new Error('原生连接请求无效。');
    if (cmd === 'prepare') {
      if (sessions.has(id) || sessions.size >= 32) throw new Error('原生连接数量已达上限。');
    } else if (!sessions.has(id)) {
      if (cmd === 'close') return;
      throw new Error('原生连接已关闭。');
    }
    const line = JSON.stringify(message);
    if (line.length > (cmd === 'send' ? 12 * 1024 * 1024 : 256 * 1024)) throw new Error('原生消息过大。');
    const proc = start();
    if (cmd === 'prepare') sessions.add(id);
    if (cmd === 'close') sessions.delete(id);
    if (!sessions.size && cmd === 'close') { stop(); return; }
    if (proc.stdin.writableLength > 16 * 1024 * 1024) throw new Error('原生连接写入队列已满。');
    return new Promise((resolve, reject) => proc.stdin.write(line + '\n', error => error ? reject(error) : resolve()));
  });
  window.webContents.on('render-process-gone', stop);
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) stop(); });
  window.once('closed', () => { stop(); ipcMain.removeHandler('roomcast:native-ice'); });
}
module.exports = { installNativeIce };
