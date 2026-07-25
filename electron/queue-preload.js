const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('queueAPI', {
  getAll: () => ipcRenderer.invoke('queue:getAll'),
  setPause: (v) => ipcRenderer.invoke('queue:pause', v),
  setConcurrency: (v) => ipcRenderer.invoke('queue:setConcurrency', v),
  stopJob: (id) => ipcRenderer.invoke('queue:stopJob', id),
  retryJob: (id) => ipcRenderer.invoke('queue:retryJob', id),
  clearJob: (id) => ipcRenderer.invoke('queue:clearJob', id),
  openPath: (p) => ipcRenderer.invoke('app:openPath', p),
  onUpdate: (cb) => {
    ipcRenderer.removeAllListeners('queue:update');
    ipcRenderer.on('queue:update', () => cb());
  }
});
