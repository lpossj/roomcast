// Preload for the dedicated update-progress window.
//
// This window exists only while an automatic update runs, and it is the only renderer
// alive once the main window has closed. It therefore gets the smallest possible API:
// read the current state, retry, open the release page for a manual download, or quit.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('roomcastUpdater', {
  desktop: true,

  status: () =>
    ipcRenderer.invoke('roomcast:update-status'),

  retry: () =>
    ipcRenderer.invoke('roomcast:update-retry'),

  openReleasePage: () =>
    ipcRenderer.invoke('roomcast:update-open-page'),

  quit: () =>
    ipcRenderer.invoke('roomcast:update-quit'),

  relaunch: () =>
    ipcRenderer.invoke('roomcast:update-relaunch'),

  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('roomcast:update-state', listener);
    return () => ipcRenderer.removeListener('roomcast:update-state', listener);
  },
});
