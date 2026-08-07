const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('subtool', {
  onUpdateData: (cb) => ipcRenderer.on('compare:update-data', (e, data) => cb(data)),
  seekMain: (time) => ipcRenderer.send('compare:seek-main', time)
});
