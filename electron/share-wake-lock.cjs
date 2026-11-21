const { powerSaveBlocker } = require('electron');

function installShareWakeLock({ ipcMain, owns, window }) {
  if (process.platform !== 'win32') return;
  let lease = null;
  let wakeLock = null;

  function release() {
    lease = null;
    if (wakeLock !== null) {
      powerSaveBlocker.stop(wakeLock);
      wakeLock = null;
    }
  }

  const channel = 'roomcast:share-wake-lock';
  const onSharing = (event, id, active) => {
    if (!owns(event, window) || typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return;
    if (active === false) {
      if (lease === id) release();
      return;
    }
    if (active !== true) return;
    lease = id;
    wakeLock ??= powerSaveBlocker.start('prevent-app-suspension');
  };
  ipcMain.on(channel, onSharing);
  window.webContents.on('render-process-gone', release);
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) release();
  });
  window.once('closed', () => {
    release();
    ipcMain.removeListener(channel, onSharing);
  });
}

module.exports = { installShareWakeLock };
