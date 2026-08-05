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
  /* 只送 {format, targetH, kbps}；輸出路徑與實際尺寸一律由主行程推導
     （路徑同資料夾、只換副檔名；解析度依專案畫布比例重算）。 */
  updateDelivery: (id, patch) => ipcRenderer.invoke('queue:updateDelivery', id, patch),
  showMainWindow: () => ipcRenderer.invoke('app:showMainWindow'),
  openPath: (p) => ipcRenderer.invoke('app:openPath', p),
  showItemInFolder: (p) => ipcRenderer.invoke('app:showItemInFolder', p),
  onUpdate: (cb) => {
    ipcRenderer.removeAllListeners('queue:update');
    ipcRenderer.on('queue:update', () => cb());
  }
});
