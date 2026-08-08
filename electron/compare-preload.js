const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('subtool', {
  onUpdateData: (callback) => ipcRenderer.on('compare:update-data', (e, data) => callback(data)),
  sendCommand: (command) => ipcRenderer.send('compare:command', command)
});
