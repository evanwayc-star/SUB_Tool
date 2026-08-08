const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('subtool', {
  onUpdateData: (callback) => ipcRenderer.on('compare:update-data', (e, data) => callback(data)),
  seekMain: (payload) => ipcRenderer.send('compare:seek-main', payload),
  matchStyle: (cueId, sourceCueId) => ipcRenderer.send('compare:match-style', cueId, sourceCueId)
});
