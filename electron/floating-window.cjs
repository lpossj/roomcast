const { ipcMain } = require('electron');
const { randomUUID } = require('node:crypto');

function installFloatingWindows(mainWindow, trusted) {
  const pending = new Map();
  const players = new Map();
  const authorized = event => event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame
    && trusted(event.senderFrame.url);
  const notify = (id, state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('roomcast:floating-state', { id, state });
  };
  ipcMain.on('roomcast:floating-prepare', event => {
    if (!authorized(event)) {
      event.returnValue = null;
      return;
    }

    for (const [id, expires] of pending) {
      if (expires < Date.now()) pending.delete(id);
    }

    if (players.size + pending.size >= 10) {
      event.returnValue = null;
      return;
    }

    const id = `roomcast-player-${randomUUID()}`;
    pending.set(id, Date.now() + 5000);
    event.returnValue = id;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    const expires = pending.get(frameName);

    pending.delete(frameName);

    if (url !== 'about:blank' || !expires || expires < Date.now()) {

      return { action: 'deny' };
    }


    return {
      action: 'allow', overrideBrowserWindowOptions: {
        width: 760, height: 480, minWidth: 360, minHeight: 240,
        alwaysOnTop: true, resizable: true, maximizable: false, minimizable: false,
        fullscreenable: true, frame: false, autoHideMenuBar: true, backgroundColor: '#080d11',
        title: 'Roomcast 共享画面', show: true,
      }
    };
  });
  mainWindow.webContents.on('did-create-window', (child, { frameName }) => {
    players.set(frameName, child);
    child.setAlwaysOnTop(true);
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', event => event.preventDefault());
    child.on('enter-full-screen', () => notify(frameName, 'FLOATING_FULLSCREEN'));
    child.on('leave-full-screen', () => notify(frameName, 'FLOATING'));
    child.once('closed', () => { players.delete(frameName); notify(frameName, 'MAIN'); });
    notify(frameName, 'FLOATING');
  });
  ipcMain.handle('roomcast:floating-action', (event, { id, action } = {}) => {
    if (!authorized(event)) throw new Error('不允许此窗口操作共享浮窗。');
    const child = players.get(id);
    if (!child || child.isDestroyed()) return;
    if (action === 'close') child.close();
    else if (action === 'fullscreen') child.setFullScreen(!child.isFullScreen());
    else throw new Error('未知浮窗操作。');
  });
  const closeAll = () => { pending.clear(); for (const child of players.values()) if (!child.isDestroyed()) child.destroy(); players.clear(); };
  mainWindow.once('closed', closeAll);
  mainWindow.webContents.on('render-process-gone', closeAll);
  mainWindow.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) closeAll(); });
}

module.exports = { installFloatingWindows };
