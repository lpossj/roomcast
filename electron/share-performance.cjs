const { constants, getPriority, setPriority } = require('node:os');
const { powerSaveBlocker } = require('electron');

const sharePriority = constants.priority.PRIORITY_ABOVE_NORMAL;

function installSharePerformance({ ipcMain, owns, window }) {
  if (process.platform !== 'win32') return;
  let lease = null;
  let wakeLock = null;
  let boosted = null;

  function release() {
    lease = null;
    if (wakeLock !== null) {
      powerSaveBlocker.stop(wakeLock);
      wakeLock = null;
    }
    if (boosted) {
      const { pid, previous } = boosted;
      boosted = null;
      try {
        if (getPriority(pid) === sharePriority) setPriority(pid, previous);
      } catch { /* The renderer may have already exited. */ }
    }
  }

  const channel = 'roomcast:share-performance';
  const onSharing = (event, id, active) => {
    if (!owns(event, window) || typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return;
    if (active === false) {
      if (lease === id) release();
      return;
    }
    if (active !== true) return;
    lease = id;
    wakeLock ??= powerSaveBlocker.start('prevent-app-suspension');
    if (boosted) return;
    // This renderer supplies capture frames, WebRTC encoding and room signaling.
    const pid = window.webContents.getOSProcessId();
    if (pid <= 0) return;
    try {
      const previous = getPriority(pid);
      if (previous > sharePriority) {
        setPriority(pid, sharePriority);
        boosted = { pid, previous };
      }
    } catch { /* Keep sharing even if Windows denies a priority change. */ }
  };
  ipcMain.on(channel, onSharing);
  window.webContents.on('render-process-gone', () => {
    boosted = null;
    release();
  });
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) release();
  });
  window.once('closed', () => {
    release();
    ipcMain.removeListener(channel, onSharing);
  });
}

module.exports = { installSharePerformance };
