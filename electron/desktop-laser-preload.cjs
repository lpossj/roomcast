const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopLaserSurface', {
  receive(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('roomcast:desktop-laser-data', listener);
    return () => ipcRenderer.removeListener('roomcast:desktop-laser-data', listener);
  },
  idle: () => ipcRenderer.send('roomcast:desktop-laser-idle'),
  ready: () => ipcRenderer.send('roomcast:desktop-laser-ready'),
});
