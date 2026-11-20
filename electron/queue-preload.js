const { contextBridge, ipcRenderer } = require('electron');
// Sandbox preload 只能載入 Electron；精確格率由 main 的共用規則判定。
const frameRates = new Map();
function exactFrameRate(value) {
  const rate = typeof value === 'number' || typeof value === 'string' ? value : 30;
  if (frameRates.has(rate)) return frameRates.get(rate);
  const exact = ipcRenderer.sendSync('queue:exactFrameRate', rate);
  if (typeof exact !== 'number' || !Number.isFinite(exact) || exact <= 0) {
    throw new Error('無效的佇列影格率回應');
  }
  if (frameRates.size >= 64) frameRates.delete(frameRates.keys().next().value);
  frameRates.set(rate, exact);
  return exact;
}

contextBridge.exposeInMainWorld('queueAPI', {
  exactFrameRate,
  getAll: () => ipcRenderer.invoke('queue:getAll'),
  estimateSize: (id, draft) => ipcRenderer.invoke('queue:estimateSize', id, draft),
  setPause: (v) => ipcRenderer.invoke('queue:pause', v),
  setConcurrency: (v) => ipcRenderer.invoke('queue:setConcurrency', v),
  stopJob: (id) => ipcRenderer.invoke('queue:stopJob', id),
  retryJob: (id) => ipcRenderer.invoke('queue:retryJob', id),
  retryWithOutputDirectory: (id) => ipcRenderer.invoke('queue:retryWithOutputDirectory', id),
  retryWithOutputConfirmation: (id) => ipcRenderer.invoke('queue:retryWithOutputConfirmation', id),
  clearJob: (id) => ipcRenderer.invoke('queue:clearJob', id),
  clearCompleted: () => ipcRenderer.invoke('queue:clearCompleted'),
  reorderJob: (id, newIndex) => ipcRenderer.invoke('queue:reorderJob', id, newIndex),
  /* 自訂尺寸送 targetW/targetH；只選高度的工作沿用專案比例。主行程驗證規格與輸出路徑。 */
  updateDelivery: (id, patch) => ipcRenderer.invoke('queue:updateDelivery', id, patch),
  showMainWindow: () => ipcRenderer.invoke('app:showMainWindow'),
  openPath: (p) => ipcRenderer.invoke('app:openPath', p),
  showItemInFolder: (p) => ipcRenderer.invoke('app:showItemInFolder', p),
  onUpdate: (cb) => {
    ipcRenderer.removeAllListeners('queue:update');
    ipcRenderer.on('queue:update', () => cb());
  }
});
