const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('queueAPI', {
  getAll: () => ipcRenderer.invoke('queue:getAll'),
  setPause: (v) => ipcRenderer.invoke('queue:pause', v),
  setConcurrency: (v) => ipcRenderer.invoke('queue:setConcurrency', v),
  stopJob: (id) => ipcRenderer.invoke('queue:stopJob', id),
  retryJob: (id) => ipcRenderer.invoke('queue:retryJob', id),
  clearJob: (id) => ipcRenderer.invoke('queue:clearJob', id),
  clearCompleted: () => ipcRenderer.invoke('queue:clearCompleted'),
  reorderJob: (id, newIndex) => ipcRenderer.invoke('queue:reorderJob', id, newIndex),
  openPath: (p) => ipcRenderer.invoke('app:openPath', p),
  showItemInFolder: (p) => ipcRenderer.invoke('app:showItemInFolder', p),
  onUpdate: (cb) => {
    ipcRenderer.removeAllListeners('queue:update');
    ipcRenderer.on('queue:update', () => cb());
  }
});
